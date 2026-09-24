/*
 * telemetry.ts — batched flush of everything itemised in docs/06-extension.md
 * ("What it sends") / docs/01-architecture.md §3.3b: activity events,
 * sniping attempts, trades, filter stats, risk-budget events, and the
 * version/health ping to `/extension/telemetry`. `telemetryOptOut`
 * (`@sl/shared`'s `userSettingsSchema`) is honoured *here*, client-side,
 * before anything is even queued for send — never as a server-side filter,
 * so an opted-out user's data never leaves the machine in the first place.
 * License heartbeat is not gated by this flag (it sends only install id +
 * version + device fingerprint hash, never product telemetry) — see
 * `lib/license.ts`, which does not import this file.
 *
 * Defect #9 fix (docs/12-testing.md "Defects found"): the queue used to be
 * a bare module-level `let queue = emptyBatches()` — MV3 service workers
 * are killed for inactivity (~30s idle) and restarted fresh on the next
 * event with all in-memory state gone, so anything queued between
 * `chrome.alarms` ticks was silently lost if the SW restarted before the
 * next tick. The queue now lives in `browser.storage.session` (falling
 * back to `.local` if `.session` throws — older Firefox, or any
 * environment without it), mirrored by an in-memory copy so every existing
 * synchronous call site (`enqueue*`, `pendingCount()`) keeps working
 * unchanged: mutations apply to the in-memory copy immediately and
 * synchronously (so there is never a read-modify-write race between two
 * enqueue calls in the same still-alive SW — JS execution here is single-
 * threaded), and a persist of the *current* state to storage is scheduled
 * after every mutation, serialised through one promise chain
 * (`schedulePersist`) so concurrent persists can never interleave and
 * clobber each other — each one always writes whatever `queue` holds at
 * the moment its turn comes up, never a stale captured snapshot. On first
 * use after a fresh SW start (the first enqueue or flush call — see
 * `ensureHydrationStarted`'s own comment for why this is lazy, not an
 * import-time side effect) a one-time hydration reads whatever the
 * previous, now-dead SW instance had persisted and merges it into the
 * in-memory queue (additively, not overwriting anything enqueued
 * synchronously before hydration resolves).
 *
 * Ingest correctness (P0 task 11):
 *  - Every sniping attempt gets a client `attemptId` when it is queued, and
 *    keeps it (and its original `occurredAt`) in the persisted queue, so a
 *    re-sent batch is recognised by the API's unique index and stored once.
 *  - Each batch type flushes on its own: a failure re-queues only the
 *    chunks that did not get through, never the batches that did (which
 *    used to be sent again and duplicated).
 *  - A batch the API rejects outright (a 4xx other than 401/403/408/429)
 *    is logged and dropped; re-sending the same payload can only fail the
 *    same way, and it used to block the queue forever.
 *  - `enqueue()` — the background's entry point — queues nothing while the
 *    user is opted out or has no account, so nothing is even stored
 *    locally for them. `flush()` still re-checks opt-out, for items queued
 *    before the user opted out.
 *  - Each batch type holds at most `MAX_QUEUED_PER_KIND` items; the oldest
 *    go first when a long outage fills it.
 *  - Timestamps are moved onto the server's clock once, as an item is
 *    queued (lib/clock.ts, from bootstrap/heartbeat `serverTime`), so a
 *    machine whose clock runs fast is not rejected by the API's 5-minute
 *    window, and a retry resends exactly what was queued.
 *  - A 400 TIMESTAMP_OUT_OF_WINDOW names the offending items
 *    (`details.indices`): only those are dropped and the rest of the chunk
 *    is sent again straight away.
 */

import { isWithinIngestWindow, isWithinTradeWindow, TIMESTAMP_OUT_OF_WINDOW } from '@sl/shared';

import { ApiError, apiJson } from './api.js';
import { hasAccount } from './auth.js';
import { ensureClockLoaded, serverNow, toServerTime } from './clock.js';
import { logger } from './logger.js';
import { getCachedSettings } from './settings.js';
import { getLocal, getSession, setLocal, setSession } from './storage.js';

import type {
  ActivityEvent,
  FilterStats,
  RiskBudgetEvent,
  SnipingAttempt,
  TelemetryEvent,
  Trade,
} from '@sl/shared';

interface QueuedBatches {
  activity: ActivityEvent[];
  sniping: SnipingAttempt[];
  trades: Trade[];
  filterStats: FilterStats[];
  riskEvents: RiskBudgetEvent[];
  telemetry: TelemetryEvent[];
}

type QueueKind = keyof QueuedBatches;

const QUEUE_STORAGE_KEY = 'sl.telemetry.queue.v1';

/** Per batch type. At a flush every 2 minutes this is hours of normal use;
 * it only fills during a long outage, and then the oldest items go. */
export const MAX_QUEUED_PER_KIND = 1000;

function emptyBatches(): QueuedBatches {
  return { activity: [], sniping: [], trades: [], filterStats: [], riskEvents: [], telemetry: [] };
}

/** Trims one batch type to the cap, oldest first. */
function capKind(q: QueuedBatches, kind: QueueKind): void {
  const list = q[kind] as unknown[];
  const over = list.length - MAX_QUEUED_PER_KIND;
  if (over > 0) {
    list.splice(0, over);
    logger.warn(`telemetry queue full: dropped the ${over} oldest ${kind} item(s)`, 'telemetry');
  }
}

function mergeInto(target: QueuedBatches, extra: QueuedBatches): QueuedBatches {
  const merged: QueuedBatches = {
    activity: [...extra.activity, ...target.activity],
    sniping: [...extra.sniping, ...target.sniping],
    trades: [...extra.trades, ...target.trades],
    filterStats: [...extra.filterStats, ...target.filterStats],
    riskEvents: [...extra.riskEvents, ...target.riskEvents],
    telemetry: [...extra.telemetry, ...target.telemetry],
  };
  for (const kind of Object.keys(merged) as QueueKind[]) capKind(merged, kind);
  return merged;
}

async function loadPersistedQueue(): Promise<QueuedBatches> {
  try {
    return await getSession<QueuedBatches>(QUEUE_STORAGE_KEY, emptyBatches());
  } catch {
    // storage.session unavailable in this browser/context — fall back to
    // storage.local (survives a restart too, which is a strict improvement
    // over losing the data, even though it's slightly less ephemeral than
    // storage.session would be).
    try {
      return await getLocal<QueuedBatches>(QUEUE_STORAGE_KEY, emptyBatches());
    } catch (err) {
      logger.warn(`telemetry queue: could not read persisted queue, starting empty: ${String(err)}`, 'telemetry');
      return emptyBatches();
    }
  }
}

async function savePersistedQueue(snapshot: QueuedBatches): Promise<void> {
  try {
    await setSession(QUEUE_STORAGE_KEY, snapshot);
  } catch {
    try {
      await setLocal(QUEUE_STORAGE_KEY, snapshot);
    } catch (err) {
      logger.warn(`telemetry queue: could not persist queue: ${String(err)}`, 'telemetry');
    }
  }
}

let queue = emptyBatches();

// One-time-per-SW-instance hydration. Deliberately *lazy* — started on
// first real use (the first enqueue or flush call), not at module import
// time: touching `browser.storage.*` as an import-time side effect would
// mean every consumer of this module (including anything that merely
// imports it transitively) pays a storage round trip before it's ever
// asked for one, for no benefit (nothing needs the recovered data before
// the first enqueue/flush anyway) — and in this repo's own test harness
// specifically, an import-time storage access runs before
// `chrome-storage-stub.ts`'s per-test storage swap is installed, which (per
// that stub's own header comment on `webextension-polyfill`'s memoized
// wrapping) has been observed to break later `storage.local` calls for the
// rest of that test file.
let hydration: Promise<void> | null = null;
function ensureHydrationStarted(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      const persisted = await loadPersistedQueue();
      queue = mergeInto(queue, persisted);
    })();
  }
  return hydration;
}

/** Resolves once this SW instance has finished recovering whatever the
 * previous instance had persisted (starts hydration on first call if it
 * hasn't already been triggered by an enqueue). Exported for `flush()` and
 * for tests that simulate a SW restart by re-importing this module. */
export async function whenHydrated(): Promise<void> {
  await ensureHydrationStarted();
}

// Serialises every write to storage so two persists scheduled in quick
// succession never interleave; each job reads `queue` fresh when it's
// actually its turn to run, so it always writes the latest state rather
// than a snapshot captured at schedule time.
let persistChain: Promise<void> = Promise.resolve();
function schedulePersist(): void {
  // Also lazily starts hydration (a no-op if already started/finished) so
  // the very first enqueue call in a fresh SW instance recovers whatever
  // the previous instance persisted *before* writing back — otherwise this
  // write could race hydration's own merge and get overwritten by it (or
  // vice versa), silently dropping either the newly-enqueued item or the
  // recovered ones.
  persistChain = persistChain
    .then(() => ensureHydrationStarted())
    .then(() => savePersistedQueue(queue))
    .catch(() => undefined);
}

/** Only for tests: lets a test await the in-flight persist chain before
 * asserting on storage contents directly. Production code never needs
 * this — every read goes through the in-memory `queue`/`pendingCount()`,
 * which are always already up to date synchronously. */
export async function whenPersisted(): Promise<void> {
  await persistChain;
}

/** Moves an item's own timestamps onto the server's clock. Filter stats
 * are left alone: `windowStart` is a local aggregation key, not a moment. */
function onServerClock<K extends QueueKind>(kind: K, items: QueuedBatches[K]): QueuedBatches[K] {
  switch (kind) {
    case 'trades':
      return (items as Trade[]).map((t) => ({
        ...t,
        boughtAt: toServerTime(t.boughtAt),
        soldAt: t.soldAt == null ? t.soldAt : toServerTime(t.soldAt),
      })) as QueuedBatches[K];
    case 'filterStats':
      return items;
    default:
      return (items as { occurredAt: string }[]).map((e) => ({
        ...e,
        occurredAt: toServerTime(e.occurredAt),
      })) as unknown as QueuedBatches[K];
  }
}

function push<K extends QueueKind>(kind: K, items: QueuedBatches[K]): void {
  // Corrected here, once: the persisted item carries the server-clock
  // timestamp, so every retry resends it unchanged (the sniping
  // idempotency key includes occurredAt).
  (queue[kind] as unknown[]).push(...onServerClock(kind, items));
  capKind(queue, kind);
  schedulePersist();
}

export function enqueueActivity(events: ActivityEvent[]): void {
  push('activity', events);
}
export function enqueueSniping(attempts: SnipingAttempt[]): void {
  // The id is minted once, here or by the caller, and persisted with the
  // attempt, so every re-send of it carries the same one.
  push(
    'sniping',
    attempts.map((a) => (a.attemptId ? a : { ...a, attemptId: crypto.randomUUID() })),
  );
}
export function enqueueTrades(trades: Trade[]): void {
  push('trades', trades);
}
export function enqueueFilterStats(stats: FilterStats[]): void {
  push('filterStats', stats);
}
export function enqueueRiskEvents(events: RiskBudgetEvent[]): void {
  push('riskEvents', events);
}
export function enqueueTelemetry(events: TelemetryEvent[]): void {
  push('telemetry', events);
}

export type TelemetryEnqueuePayload =
  | { kind: 'activity'; items: ActivityEvent[] }
  | { kind: 'sniping'; items: SnipingAttempt[] }
  | { kind: 'trades'; items: Trade[] }
  | { kind: 'filterStats'; items: FilterStats[] }
  | { kind: 'riskEvents'; items: RiskBudgetEvent[] }
  | { kind: 'event'; items: TelemetryEvent[] };

/** Whether anything may be queued at all: never for a user who opted out
 * (their data should not even sit in local storage waiting to be sent),
 * and never without an account (nothing could ever send it). */
async function mayQueue(): Promise<boolean> {
  const settings = await getCachedSettings();
  if (settings.telemetryOptOut) return false;
  return hasAccount();
}

/** The background's entry point for `telemetry.enqueue` messages. */
export async function enqueue(payload: TelemetryEnqueuePayload): Promise<{ queued: number }> {
  if (!(await mayQueue())) return { queued: 0 };
  await ensureClockLoaded();
  switch (payload.kind) {
    case 'activity':
      enqueueActivity(payload.items);
      break;
    case 'sniping':
      enqueueSniping(payload.items);
      break;
    case 'trades':
      enqueueTrades(payload.items);
      break;
    case 'filterStats':
      enqueueFilterStats(payload.items);
      break;
    case 'riskEvents':
      enqueueRiskEvents(payload.items);
      break;
    case 'event':
      enqueueTelemetry(payload.items);
      break;
  }
  return { queued: payload.items.length };
}

export function pendingCount(): number {
  const q = queue;
  return q.activity.length + q.sniping.length + q.trades.length + q.filterStats.length + q.riskEvents.length + q.telemetry.length;
}

/** A 4xx the same payload will always get again. 401 (session expired,
 * resolved by the next login/refresh), 403 (account state that can change),
 * 408 and 429 (transient) are worth keeping for the next tick; anything
 * else in the 4xx range — a validation failure, a batch too large — is
 * not, and re-queueing it would block every later item of that type. */
function isPermanentRejection(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    ![401, 403, 408, 429].includes(err.status)
  );
}

interface KindResult<T> {
  sent: number;
  /** Items to put back for the next tick (the chunk that failed and every
   * chunk after it). */
  unsent: T[];
  ok: boolean;
}

/** The offending item indices of a TIMESTAMP_OUT_OF_WINDOW rejection, or
 * `null` for anything else. */
function outOfWindowIndices(err: unknown, chunkLength: number): Set<number> | null {
  if (!(err instanceof ApiError) || err.status !== 400 || err.code !== TIMESTAMP_OUT_OF_WINDOW) return null;
  const raw = (err.details as { indices?: unknown } | undefined)?.indices;
  if (!Array.isArray(raw)) return null;
  const indices = new Set(raw.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < chunkLength));
  return indices.size > 0 ? indices : null;
}

/** Sends one batch type in chunks. Stops at the first retryable failure and
 * hands back what was not sent; a permanently rejected chunk is dropped and
 * the rest still go. A chunk rejected for out-of-window timestamps loses
 * only the items the API named, and the rest of it is sent again at once. */
async function postBatch<T>(
  path: string,
  key: string,
  items: T[],
  chunkSize: number,
): Promise<KindResult<T>> {
  let sent = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    let chunk = items.slice(i, i + chunkSize);
    // One resend per rejected item at most: each rejection removes at
    // least one item, so this always ends.
    for (;;) {
      try {
        if (chunk.length > 0) await apiJson(path, { method: 'POST', body: JSON.stringify({ [key]: chunk }) });
        sent += chunk.length;
        break;
      } catch (err) {
        const bad = outOfWindowIndices(err, chunk.length);
        if (bad) {
          logger.warn(`telemetry: ${path} rejected ${bad.size} item(s) as outside the time window, dropping only those`, 'telemetry');
          chunk = chunk.filter((_, index) => !bad.has(index));
          continue;
        }
        if (isPermanentRejection(err)) {
          logger.warn(
            `telemetry: ${path} rejected ${chunk.length} item(s) with ${err.status} ${err.code}, dropping them: ${err.message}`,
            'telemetry',
          );
          break;
        }
        logger.warn(`telemetry flush of ${path} failed, re-queueing ${items.length - i} item(s): ${String(err)}`, 'telemetry');
        return { sent, unsent: [...chunk, ...items.slice(i + chunkSize)], ok: false };
      }
    }
  }
  return { sent, unsent: [], ok: true };
}

/** Drops items whose timestamps the API would reject (@sl/shared's ingest
 * windows: activity and sniping 7 days back, trades 400 days back, all 5
 * minutes ahead), judged on the server's clock (lib/clock.ts), so one stale
 * item cannot get a whole chunk rejected. Only the batch types the API
 * bounds are filtered. */
function dropOutOfWindow(q: QueuedBatches): QueuedBatches {
  const now = serverNow();
  // Only drops what is provably outside the window; anything malformed is
  // left for the API to judge (and a 4xx then drops it anyway).
  const parses = (iso: string | undefined) => Number.isFinite(Date.parse(iso ?? ''));
  const inWindow = (iso: string | undefined) => !parses(iso) || isWithinIngestWindow(iso as string, now);
  const inTradeWindow = (iso: string | undefined) => !parses(iso) || isWithinTradeWindow(iso as string, now);
  const kept: QueuedBatches = {
    ...q,
    activity: q.activity.filter((e) => inWindow(e.occurredAt)),
    sniping: q.sniping.filter((a) => inWindow(a.occurredAt)),
    trades: q.trades.filter((t) => inTradeWindow(t.boughtAt) && (t.soldAt == null || inTradeWindow(t.soldAt))),
  };
  const dropped =
    q.activity.length - kept.activity.length +
    q.sniping.length - kept.sniping.length +
    q.trades.length - kept.trades.length;
  if (dropped > 0) logger.warn(`telemetry: dropping ${dropped} queued item(s) too old for the API to accept`, 'telemetry');
  return kept;
}

/** Flush every queued batch. Opt-out (checked fresh, not cached at enqueue
 * time) drops everything except risk-budget events and error reports are
 * out of scope here — telemetry opt-out only ever suppresses *this* file's
 * batches, per docs/06-extension.md's itemised "What it sends" list. Each
 * batch type is sent independently: one that fails is re-queued (only its
 * unsent chunks) for the next alarm tick, one the API rejects outright is
 * dropped, and the others are done either way. Always waits for hydration
 * first, so a flush called right after a fresh SW start includes whatever
 * the previous instance had queued but never got to send. */
export async function flush(): Promise<{ ok: boolean; sent: number }> {
  await ensureHydrationStarted();

  const settings = await getCachedSettings();
  if (settings.telemetryOptOut) {
    logger.debug(`telemetry opted out — dropping ${pendingCount()} queued item(s) locally`, 'telemetry');
    queue = emptyBatches();
    schedulePersist();
    return { ok: true, sent: 0 }; // "sent: 0" is deliberate — nothing left this machine
  }

  const toFlush = dropOutOfWindow(queue);
  queue = emptyBatches();
  schedulePersist();

  // Route paths below must match apps/api's actual registrations exactly
  // (modules/activity, modules/sniping, modules/trades all register
  // under a `/batch` or `/attempts` suffix, not the bare collection
  // path) — found and fixed alongside defect #4 while writing
  // apps/api/src/test/qa/__tests__/extension-api-contract.test.ts, which
  // now pins every one of these against apps/api/openapi/openapi.json so
  // this can't silently regress again. Chunk sizes are the API's own
  // per-request caps (packages/shared/src/schemas/*.ts): activity and
  // telemetry 500, the rest 200.
  //
  // Bug fix: this used to be `Promise.all`, so one rejected POST (e.g. the
  // risk-events endpoint down) threw before the other five settled results
  // could be inspected, and the single `catch` below re-queued *all six*
  // batches — including the ones that had already gotten a 2xx — so the
  // next alarm tick re-sent them and the API recorded duplicates. Each
  // batch below is independent (different endpoint, different rows), so
  // `Promise.allSettled` lets each one's outcome be judged on its own:
  // only what failed gets put back on the queue. Within a batch type,
  // `postBatch` hands back just the chunks that did not get through, so a
  // chunk that already got a 2xx is not re-sent either.
  const batches: Array<{ label: string; items: unknown[]; requeue: (items: never[]) => void }> = [
    { label: 'activity', items: toFlush.activity, requeue: (items) => queue.activity.unshift(...items) },
    { label: 'sniping', items: toFlush.sniping, requeue: (items) => queue.sniping.unshift(...items) },
    { label: 'trades', items: toFlush.trades, requeue: (items) => queue.trades.unshift(...items) },
    { label: 'filterStats', items: toFlush.filterStats, requeue: (items) => queue.filterStats.unshift(...items) },
    { label: 'riskEvents', items: toFlush.riskEvents, requeue: (items) => queue.riskEvents.unshift(...items) },
    { label: 'telemetry', items: toFlush.telemetry, requeue: (items) => queue.telemetry.unshift(...items) },
  ];

  const results = await Promise.allSettled([
    postBatch('/api/v1/activity/batch', 'events', toFlush.activity, 500),
    postBatch('/api/v1/sniping/attempts', 'attempts', toFlush.sniping, 200),
    postBatch('/api/v1/trades/batch', 'trades', toFlush.trades, 200),
    postBatch('/api/v1/filters/stats', 'stats', toFlush.filterStats, 200),
    postBatch('/api/v1/risk-events', 'events', toFlush.riskEvents, 200),
    postBatch('/api/v1/extension/telemetry', 'events', toFlush.telemetry, 500),
  ]);

  let sentCount = 0;
  let anyFailed = false;
  results.forEach((result, i) => {
    const batch = batches[i]; // `results` and `batches` are the same fixed-length, index-aligned arrays above
    if (!batch) return;
    if (result.status === 'rejected') {
      // postBatch catches its own request failures, so this is something
      // unexpected; keep the whole batch for the next tick.
      anyFailed = true;
      logger.warn(`telemetry flush: ${batch.label} batch failed, re-queueing: ${String(result.reason)}`, 'telemetry');
      batch.requeue(batch.items as never[]);
      return;
    }
    sentCount += result.value.sent;
    if (!result.value.ok) anyFailed = true;
    // Unsent items are older than anything enqueued while the flush was in
    // flight, so they go back in front.
    if (result.value.unsent.length > 0) batch.requeue(result.value.unsent as never[]);
  });
  for (const kind of Object.keys(queue) as QueueKind[]) capKind(queue, kind);
  schedulePersist();

  return { ok: !anyFailed, sent: sentCount };
}
