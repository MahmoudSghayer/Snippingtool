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
 */

import { apiJson } from './api.js';
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

const QUEUE_STORAGE_KEY = 'sl.telemetry.queue.v1';

function emptyBatches(): QueuedBatches {
  return { activity: [], sniping: [], trades: [], filterStats: [], riskEvents: [], telemetry: [] };
}

function mergeInto(target: QueuedBatches, extra: QueuedBatches): QueuedBatches {
  return {
    activity: [...extra.activity, ...target.activity],
    sniping: [...extra.sniping, ...target.sniping],
    trades: [...extra.trades, ...target.trades],
    filterStats: [...extra.filterStats, ...target.filterStats],
    riskEvents: [...extra.riskEvents, ...target.riskEvents],
    telemetry: [...extra.telemetry, ...target.telemetry],
  };
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

export function enqueueActivity(events: ActivityEvent[]): void {
  queue.activity.push(...events);
  schedulePersist();
}
export function enqueueSniping(attempts: SnipingAttempt[]): void {
  queue.sniping.push(...attempts);
  schedulePersist();
}
export function enqueueTrades(trades: Trade[]): void {
  queue.trades.push(...trades);
  schedulePersist();
}
export function enqueueFilterStats(stats: FilterStats[]): void {
  queue.filterStats.push(...stats);
  schedulePersist();
}
export function enqueueRiskEvents(events: RiskBudgetEvent[]): void {
  queue.riskEvents.push(...events);
  schedulePersist();
}
export function enqueueTelemetry(events: TelemetryEvent[]): void {
  queue.telemetry.push(...events);
  schedulePersist();
}

export function pendingCount(): number {
  const q = queue;
  return q.activity.length + q.sniping.length + q.trades.length + q.filterStats.length + q.riskEvents.length + q.telemetry.length;
}

async function postBatch<T>(path: string, body: Record<string, T[]>): Promise<void> {
  const [key] = Object.keys(body);
  const list = key ? body[key] : undefined;
  if (!list || list.length === 0) return;
  // The API caps every batch endpoint (activity 500, sniping/trades/filters/
  // risk-events 200 each — packages/shared/src/schemas/*.ts); chunk so one
  // oversized local queue never fails an entire flush.
  const CHUNK = path === '/api/v1/activity/batch' ? 500 : 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    await apiJson(path, { method: 'POST', body: JSON.stringify({ [key as string]: chunk }) });
  }
}

/** Flush every queued batch. Opt-out (checked fresh, not cached at enqueue
 * time) drops everything except risk-budget events and error reports are
 * out of scope here — telemetry opt-out only ever suppresses *this* file's
 * batches, per docs/06-extension.md's itemised "What it sends" list; a
 * batch whose own POST fails keeps only *that* batch queued so the next
 * alarm tick retries it rather than silently dropping data — batches whose
 * POST already succeeded are not re-queued (see the defect fix below).
 * Always waits for hydration first, so a flush called right after a fresh
 * SW start includes whatever the previous instance had queued but never
 * got to send. */
export async function flush(): Promise<{ ok: boolean; sent: number }> {
  await ensureHydrationStarted();

  const settings = await getCachedSettings();
  if (settings.telemetryOptOut) {
    logger.debug(`telemetry opted out — dropping ${pendingCount()} queued item(s) locally`, 'telemetry');
    queue = emptyBatches();
    schedulePersist();
    return { ok: true, sent: 0 }; // "sent: 0" is deliberate — nothing left this machine
  }

  const toFlush = queue;
  queue = emptyBatches();
  schedulePersist();

  // Route paths below must match apps/api's actual registrations exactly
  // (modules/activity, modules/sniping, modules/trades all register
  // under a `/batch` or `/attempts` suffix, not the bare collection
  // path) — found and fixed alongside defect #4 while writing
  // apps/api/src/test/qa/__tests__/extension-api-contract.test.ts, which
  // now pins every one of these against apps/api/openapi/openapi.json so
  // this can't silently regress again.
  //
  // Bug fix: this used to be `Promise.all`, so one rejected POST (e.g. the
  // risk-events endpoint down) threw before the other five settled results
  // could be inspected, and the single `catch` below re-queued *all six*
  // batches — including the ones that had already gotten a 2xx — so the
  // next alarm tick re-sent them and the API recorded duplicates. Each
  // batch below is independent (different endpoint, different rows), so
  // `Promise.allSettled` lets each one's outcome be judged on its own:
  // only the batches whose own request failed get put back on the queue.
  const batches: Array<{ label: string; items: unknown[]; requeue: () => void }> = [
    { label: 'activity', items: toFlush.activity, requeue: () => queue.activity.unshift(...toFlush.activity) },
    { label: 'sniping', items: toFlush.sniping, requeue: () => queue.sniping.unshift(...toFlush.sniping) },
    { label: 'trades', items: toFlush.trades, requeue: () => queue.trades.unshift(...toFlush.trades) },
    { label: 'filterStats', items: toFlush.filterStats, requeue: () => queue.filterStats.unshift(...toFlush.filterStats) },
    { label: 'riskEvents', items: toFlush.riskEvents, requeue: () => queue.riskEvents.unshift(...toFlush.riskEvents) },
    { label: 'telemetry', items: toFlush.telemetry, requeue: () => queue.telemetry.unshift(...toFlush.telemetry) },
  ];

  const results = await Promise.allSettled([
    postBatch('/api/v1/activity/batch', { events: toFlush.activity }),
    postBatch('/api/v1/sniping/attempts', { attempts: toFlush.sniping }),
    postBatch('/api/v1/trades/batch', { trades: toFlush.trades }),
    postBatch('/api/v1/filters/stats', { stats: toFlush.filterStats }),
    postBatch('/api/v1/risk-events', { events: toFlush.riskEvents }),
    toFlush.telemetry.length
      ? apiJson('/api/v1/extension/telemetry', {
          method: 'POST',
          body: JSON.stringify({ events: toFlush.telemetry }),
        })
      : Promise.resolve(),
  ]);

  let sentCount = 0;
  let anyFailed = false;
  results.forEach((result, i) => {
    const batch = batches[i]; // `results` and `batches` are the same fixed-length, index-aligned arrays above
    if (!batch) return;
    if (result.status === 'rejected') {
      anyFailed = true;
      logger.warn(`telemetry flush: ${batch.label} batch failed, re-queueing: ${String(result.reason)}`, 'telemetry');
      // Put just this batch back so the next alarm tick retries only it —
      // batches that already got a 2xx above are not touched here.
      batch.requeue();
    } else {
      sentCount += batch.items.length;
    }
  });
  if (anyFailed) schedulePersist();

  return { ok: !anyFailed, sent: sentCount };
}
