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
 */
import { getCachedSettings } from '../lib/settings.js';
import { getSession, setSession } from '../lib/storage.js';
import * as telemetry from '../lib/telemetry.js';
import { queueSale, TradeLifecycle } from '../lib/trade-lifecycle.js';
import { idbLifecycleStore } from '../store/lifecycle-db.js';

import type { LifecycleBuy, LifecycleSessionPnl, LifecycleStats, TradePileItem } from '@sl/shared';

const SESSION_START_KEY = 'sl.lifecycle.sessionStart.v1';
const NO_ITEM_ID_KEY = 'sl.lifecycle.buysWithoutItemId.v1';

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
 * service worker starts, and again on every heartbeat alarm. */
export function retryUnreportedSales(): Promise<number> {
  return lifecycle.resumeUnreported().catch(() => 0);
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
