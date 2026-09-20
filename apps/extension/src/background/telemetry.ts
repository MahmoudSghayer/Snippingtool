/*
 * background/telemetry.ts — routes `telemetry.enqueue` messages into
 * `lib/telemetry.ts`'s in-memory queues and flushes them on a
 * `chrome.alarms` tick (never a `setInterval`). `content/index.ts` is the
 * only sender; this file just dispatches by `kind`.
 */
import type { ActivityEvent, FilterStats, RiskBudgetEvent, SnipingAttempt, TelemetryEvent, Trade } from '@sl/shared';
import browser from 'webextension-polyfill';

import * as telemetry from '../lib/telemetry.js';
import { logger } from '../lib/logger.js';

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
