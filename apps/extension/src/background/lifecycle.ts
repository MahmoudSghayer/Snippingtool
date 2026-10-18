/*
 * background/lifecycle.ts — runs the trade lifecycle (lib/trade-lifecycle.ts)
 * for every EA tab at once, over IndexedDB (store/lifecycle-db.ts). In
 * background, not content: two tabs showing the same trade pile then share
 * one record per item, so a sale is still reported once.
 *
 * A sale goes into the same telemetry queue as the buy (`trades` ->
 * `/trades/batch`), which already persists, retries and re-sends it. It
 * counts as reported only once that queue has it on disk; a sale that
 * could not be queued is retried on every heartbeat.
 *
 * The records are this browser's, so they are seeded from the account's
 * open trades (`GET /api/v1/extension/open-trades`, lib/lifecycle-seed.ts):
 * at boot once signed in, after a sign-in, when the bot starts, every 15
 * minutes while it runs (the `sl.lifecycle.seed` alarm), and before a
 * trade-pile read when the last seed is older than that. A card bought in
 * another browser is then followed here and its sale reported on the
 * original buy's tradeId. All of it runs in the userscript too (its
 * browser shim maps the alarm to a timer and `storage.session` to its own
 * store).
 */
import {
  openTradesResponseSchema,
  type LifecycleBuy,
  type LifecycleSessionPnl,
  type LifecycleStats,
  type OpenTradesResponse,
  type TradePileItem,
} from '@sl/shared';
import browser from 'webextension-polyfill';

import { apiJson, NetworkError } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';
import { ensureClockLoaded, toLocalTime } from '../lib/clock.js';
import { createLifecycleSeeder, SEED_EVERY_MS } from '../lib/lifecycle-seed.js';
import { logger } from '../lib/logger.js';
import { getCachedSettings } from '../lib/settings.js';
import { getSession, setSession } from '../lib/storage.js';
import * as telemetry from '../lib/telemetry.js';
import { queueSale, TradeLifecycle } from '../lib/trade-lifecycle.js';
import { idbLifecycleStore } from '../store/lifecycle-db.js';

import { currentEngineState } from './engine-lease.js';

const SESSION_START_KEY = 'sl.lifecycle.sessionStart.v1';
const NO_ITEM_ID_KEY = 'sl.lifecycle.buysWithoutItemId.v1';
const SEEDED_AT_KEY = 'sl.lifecycle.seededAt.v1';
export const LIFECYCLE_SEED_ALARM = 'sl.lifecycle.seed';
/** A bot start re-reads the open trades unless they were read this recently. */
export const BOT_START_SEED_MAX_AGE_MS = 60_000;
/** How long a trade-pile read waits for a seed it started. Past this the
 * read goes ahead; the seed still lands, and the next read sees it. */
const PILE_SEED_WAIT_MS = 5_000;

const lifecycle = new TradeLifecycle({
  store: idbLifecycleStore,
  reportSale: queueSale({
    enqueue: (trade) => telemetry.enqueue({ kind: 'trades', items: [trade] }),
    persisted: () => telemetry.whenPersisted(),
    optedOut: async () => (await getCachedSettings()).telemetryOptOut,
  }),
  // In `storage.session`, with the session start: it survives the worker
  // stopping, and counts per browser session.
  counter: {
    get: () => getSession<number>(NO_ITEM_ID_KEY, 0),
    set: (value) => setSession(NO_ITEM_ID_KEY, value),
  },
});

/** Re-send any sale persisted but not yet handed over: once when the
 * service worker starts, and again on every heartbeat alarm. The first
 * call also reports, once, each `gone` record from before `goneFrom`
 * existed (lib/trade-lifecycle.ts `resumeUnreported`), and re-sends the
 * buys recorded before buy reports carried the card's item id, so the
 * account's other browsers can follow those cards too (`reportItemIds`). */
export async function retryUnreportedSales(): Promise<number> {
  const sent = await lifecycle.resumeUnreported().catch(() => 0);
  await lifecycle.reportItemIds().catch(() => 0);
  return sent;
}

let openTradesWarned = false;

/** The account's open trades, their purchase times moved onto this
 * browser's clock (the sale report moves them back). Null when they cannot
 * be asked for: signed out, opted out of telemetry (no sale would be sent),
 * offline, or refused (a plan without the ledger). */
async function fetchOpenTrades(): Promise<OpenTradesResponse | null> {
  if (!(await isAuthenticated())) return null;
  if ((await getCachedSettings()).telemetryOptOut) return null;
  let body: unknown;
  try {
    body = await apiJson<unknown>('/api/v1/extension/open-trades', {}, { retries: 0 });
  } catch (err) {
    // Logged once per worker: every warning becomes an error report.
    if (!(err instanceof NetworkError) && !openTradesWarned) {
      openTradesWarned = true;
      logger.warn(`open trades not read: ${String(err)}`, 'lifecycle');
    }
    return null;
  }
  const parsed = openTradesResponseSchema.safeParse(body);
  if (!parsed.success) {
    if (!openTradesWarned) {
      openTradesWarned = true;
      logger.warn('open trades: the response did not match the schema', 'lifecycle');
    }
    return null;
  }
  await ensureClockLoaded();
  return { ...parsed.data, items: parsed.data.items.map((t) => ({ ...t, boughtAt: toLocalTime(t.boughtAt) })) };
}

const seeder = createLifecycleSeeder({
  lifecycle,
  fetchOpenTrades,
  // In `storage.session`: a service worker restarted within the interval
  // does not ask again, a new browser session does.
  lastSeeded: {
    get: () => getSession<number>(SEEDED_AT_KEY, 0),
    set: (at) => setSession(SEEDED_AT_KEY, at),
  },
});

/** Adds the account's open trades to this browser's records, unless they
 * were read less than `maxAgeMs` ago. Never rejects. */
export function seedOpenTrades(maxAgeMs: number = SEED_EVERY_MS): Promise<number> {
  return seeder.run(maxAgeMs);
}

export function ensureLifecycleSeedAlarm(): void {
  browser.alarms.create(LIFECYCLE_SEED_ALARM, { periodInMinutes: SEED_EVERY_MS / 60_000 });
}

/** The 15-minute alarm: re-reads the open trades while the bot runs. A
 * minute of slack, so a seed from a trade-pile read just before does not
 * push this one to the next tick. */
export async function onLifecycleSeedAlarm(): Promise<void> {
  if ((await currentEngineState()) !== 'running') return;
  await seedOpenTrades(SEED_EVERY_MS - 60_000);
}

let resumed: Promise<unknown> | null = null;
function resumeOnce(): Promise<unknown> {
  resumed ??= retryUnreportedSales();
  return resumed;
}

/** The browser session's start (`storage.session` outlives a service
 * worker restart but not the browser): "this session" for P&L. */
async function sessionStart(): Promise<number> {
  const stored = await getSession<number | null>(SESSION_START_KEY, null);
  if (typeof stored === 'number') return stored;
  const now = Date.now();
  await setSession(SESSION_START_KEY, now);
  return now;
}

export async function handleLifecycleBuy(payload: LifecycleBuy): Promise<{ ok: true }> {
  await resumeOnce();
  await lifecycle.recordBuy(payload);
  return { ok: true };
}

export async function handleLifecyclePile(payload: { items: TradePileItem[]; full?: boolean }): Promise<{ reported: number }> {
  await resumeOnce();
  // A pile judged on stale records could miss the sale of a card another
  // browser bought (the bot's start reloads the pile at once, say).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PILE_SEED_WAIT_MS);
  });
  try {
    await Promise.race([seedOpenTrades(), waited]);
  } finally {
    clearTimeout(timer);
  }
  return { reported: await lifecycle.observePile(payload.items, { full: payload.full === true }) };
}

export async function handleLifecycleSessionPnl(): Promise<LifecycleSessionPnl> {
  await resumeOnce();
  return lifecycle.sessionPnl(await sessionStart());
}

/** `lifecycle.todayPnl`: realised profit since local midnight, for the
 * popup's daily profit goal (`targets.dailyProfitGoal`). */
export async function handleLifecycleTodayPnl(): Promise<LifecycleSessionPnl> {
  await resumeOnce();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return lifecycle.sessionPnl(midnight.getTime());
}

export function handleLifecycleStats(): Promise<LifecycleStats> {
  return lifecycle.stats();
}
