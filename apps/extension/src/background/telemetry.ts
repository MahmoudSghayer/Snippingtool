/*
 * background/telemetry.ts — routes `telemetry.enqueue` messages into
 * `lib/telemetry.ts`'s in-memory queues and flushes them on a
 * `chrome.alarms` tick (never a `setInterval`). `content/index.ts` is the
 * only sender; this file just dispatches by `kind`.
 */
import browser from 'webextension-polyfill';

import { logger } from '../lib/logger.js';
import * as telemetry from '../lib/telemetry.js';

import type { ActivityEvent, FilterStats, RiskBudgetEvent, SnipingAttempt, TelemetryEvent, Trade } from '@sl/shared';

const FLUSH_ALARM = 'sl.telemetry.flush';
const FLUSH_PERIOD_MINUTES = 2;

export function ensureFlushAlarm(): void {
  browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MINUTES });
}

export type TelemetryEnqueuePayload =
  | { kind: 'activity'; items: ActivityEvent[] }
  | { kind: 'sniping'; items: SnipingAttempt[] }
  | { kind: 'trades'; items: Trade[] }
  | { kind: 'filterStats'; items: FilterStats[] }
  | { kind: 'riskEvents'; items: RiskBudgetEvent[] }
  | { kind: 'event'; items: TelemetryEvent[] };

export function handleTelemetryEnqueue(payload: TelemetryEnqueuePayload): { queued: number } {
  switch (payload.kind) {
    case 'activity':
      telemetry.enqueueActivity(payload.items);
      break;
    case 'sniping':
      telemetry.enqueueSniping(payload.items);
      break;
    case 'trades':
      telemetry.enqueueTrades(payload.items);
      break;
    case 'filterStats':
      telemetry.enqueueFilterStats(payload.items);
      break;
    case 'riskEvents':
      telemetry.enqueueRiskEvents(payload.items);
      break;
    case 'event':
      telemetry.enqueueTelemetry(payload.items);
      break;
  }
  return { queued: payload.items.length };
}

export async function handleTelemetryFlush(): Promise<{ ok: boolean; sent: number }> {
  return telemetry.flush();
}

export async function onFlushAlarm(): Promise<void> {
  const result = await telemetry.flush();
  if (!result.ok) logger.debug('scheduled telemetry flush failed, will retry next tick', 'telemetry');
}

// Defect #9 (docs/12-testing.md "Defects found"): best-effort extra flush
// attempt when the browser is about to unload this extension's background
// context — `chrome.runtime.onSuspend` is the MV3/event-page analogue of a
// page's `beforeunload` (there is no DOM/window in a service worker, so
// that event itself doesn't exist here; webextension-polyfill's own type
// definitions don't model this event at all, so it's read off the raw
// `chrome` global rather than `browser`). This is *not* the safety net —
// `lib/telemetry.ts`'s persistence to `storage.session`/`.local` on every
// enqueue is (registered at that module's own import time, unconditionally,
// so it depends on nothing here) — it just means a suspend that arrives
// with an idle queue and network available gets it sent immediately rather
// than waiting for the next alarm tick or the next SW wake's hydration.
// `onSuspend` is not guaranteed to fire before an MV3 SW is evicted for
// idle timeout (Chrome's own documented caveat), and there is no reliable
// way to await async work once it does fire — this is fire-and-forget by
// necessity, guarded so a browser/test environment without this global at
// all never throws on import.
if (typeof chrome !== 'undefined' && chrome.runtime?.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    void telemetry.flush().catch(() => undefined);
  });
}
