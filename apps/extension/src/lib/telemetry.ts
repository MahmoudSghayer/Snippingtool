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
 */

import { apiJson } from './api.js';
import { logger } from './logger.js';
import { getCachedSettings } from './settings.js';

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

function emptyBatches(): QueuedBatches {
  return { activity: [], sniping: [], trades: [], filterStats: [], riskEvents: [], telemetry: [] };
}

let queue = emptyBatches();

export function enqueueActivity(events: ActivityEvent[]): void {
  queue.activity.push(...events);
}
export function enqueueSniping(attempts: SnipingAttempt[]): void {
  queue.sniping.push(...attempts);
}
export function enqueueTrades(trades: Trade[]): void {
  queue.trades.push(...trades);
}
export function enqueueFilterStats(stats: FilterStats[]): void {
  queue.filterStats.push(...stats);
}
export function enqueueRiskEvents(events: RiskBudgetEvent[]): void {
  queue.riskEvents.push(...events);
}
export function enqueueTelemetry(events: TelemetryEvent[]): void {
  queue.telemetry.push(...events);
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
  const CHUNK = path === '/api/v1/activity' ? 500 : 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    await apiJson(path, { method: 'POST', body: JSON.stringify({ [key as string]: chunk }) });
  }
}

/** Flush every queued batch. Opt-out (checked fresh, not cached at enqueue
 * time) drops everything except risk-budget events and error reports are
 * out of scope here — telemetry opt-out only ever suppresses *this* file's
 * batches, per docs/06-extension.md's itemised "What it sends" list; a
 * failed flush keeps the queue intact so the next alarm tick retries rather
 * than silently dropping data. */
export async function flush(): Promise<{ ok: boolean; sent: number }> {
  const settings = await getCachedSettings();
  if (settings.telemetryOptOut) {
    logger.debug(`telemetry opted out — dropping ${pendingCount()} queued item(s) locally`, 'telemetry');
    queue = emptyBatches();
    return { ok: true, sent: 0 }; // "sent: 0" is deliberate — nothing left this machine
  }

  const toFlush = queue;
  const sent =
    toFlush.activity.length +
    toFlush.sniping.length +
    toFlush.trades.length +
    toFlush.filterStats.length +
    toFlush.riskEvents.length +
    toFlush.telemetry.length;
  queue = emptyBatches();

  try {
    await Promise.all([
      postBatch('/api/v1/activity', { events: toFlush.activity }),
      postBatch('/api/v1/sniping', { attempts: toFlush.sniping }),
      postBatch('/api/v1/trades', { trades: toFlush.trades }),
      postBatch('/api/v1/filters/stats', { stats: toFlush.filterStats }),
      postBatch('/api/v1/risk-events', { events: toFlush.riskEvents }),
      toFlush.telemetry.length
        ? apiJson('/api/v1/extension/telemetry', {
            method: 'POST',
            body: JSON.stringify({ events: toFlush.telemetry }),
          })
        : Promise.resolve(),
    ]);
    return { ok: true, sent };
  } catch (err) {
    logger.warn(`telemetry flush failed, re-queueing: ${String(err)}`, 'telemetry');
    // Put everything back so the next alarm tick retries instead of losing it.
    queue.activity.unshift(...toFlush.activity);
    queue.sniping.unshift(...toFlush.sniping);
    queue.trades.unshift(...toFlush.trades);
    queue.filterStats.unshift(...toFlush.filterStats);
    queue.riskEvents.unshift(...toFlush.riskEvents);
    queue.telemetry.unshift(...toFlush.telemetry);
    return { ok: false, sent: 0 };
  }
}
