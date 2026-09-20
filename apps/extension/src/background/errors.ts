/*
 * background/errors.ts — flushes `lib/errors.ts`'s ring-buffer report on
 * request (`errors.report` message) and on a `chrome.alarms` tick, plus
 * catches the service worker's own uncaught errors so a background crash is
 * itself reportable (docs/06-extension.md, "error reporting").
 */
import browser from 'webextension-polyfill';

import { flushErrors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getLocal } from '../lib/storage.js';

const FLUSH_ALARM = 'sl.errors.flush';
const FLUSH_PERIOD_MINUTES = 5;
const DEVICE_ID_KEY = 'sl.deviceId';

export function ensureErrorFlushAlarm(): void {
  browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MINUTES });
}

export function installGlobalErrorHandlers(scope: typeof globalThis = globalThis): void {
  scope.addEventListener?.('error', (event) => {
    const err = (event as ErrorEvent).error as Error | undefined;
    logger.error(err?.message ?? String((event as ErrorEvent).message ?? 'unknown error'), 'background.uncaught');
  });
  scope.addEventListener?.('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    logger.error(reason instanceof Error ? reason.message : String(reason), 'background.unhandledrejection');
  });
}

export async function handleErrorsReport(): Promise<{ ok: boolean; sent: number }> {
  const deviceId = await getLocal<string | null>(DEVICE_ID_KEY, null);
  return flushErrors(deviceId);
}

export async function onErrorFlushAlarm(): Promise<void> {
  await handleErrorsReport();
}
