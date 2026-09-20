/*
 * errors.ts — flushes `lib/logger.ts`'s ring buffer to `/extension/errors`.
 * Only `warn`/`error`-level entries are reported (matching what the logger
 * already echoes to the console); `message`/`stack`/`context` only — never
 * user input, never a listing, matching `extensionErrorReportSchema`
 * (packages/shared). Independent of the telemetry opt-out (error reports
 * are diagnostics about the extension itself, not product-usage telemetry —
 * see docs/06-extension.md, "What it sends" for the exact line this maps
 * to), but still local-only until a device is registered (no `deviceId` yet
 * means nothing to flush).
 */
import type { ExtensionErrorReport } from '@sl/shared';

import { apiJson } from './api.js';
import { exportLogs, type LogEntry } from './logger.js';

const EXTENSION_VERSION = import.meta.env.VITE_EXTENSION_VERSION;

function toReportEntry(entry: LogEntry): ExtensionErrorReport['errors'][number] {
  return {
    message: entry.message.slice(0, 2000),
    context: entry.context?.slice(0, 120),
    occurredAt: new Date(entry.at).toISOString(),
  };
}

export async function flushErrors(deviceId: string | null): Promise<{ ok: boolean; sent: number }> {
  if (!deviceId) return { ok: false, sent: 0 };
  const reportable = exportLogs().filter((e) => e.level === 'warn' || e.level === 'error');
  if (reportable.length === 0) return { ok: true, sent: 0 };

  const errors = reportable.slice(0, 100).map(toReportEntry);
  const body: ExtensionErrorReport = { deviceId, extensionVersion: EXTENSION_VERSION, errors };
  try {
    await apiJson('/api/v1/extension/errors', { method: 'POST', body: JSON.stringify(body) });
    return { ok: true, sent: errors.length };
  } catch {
    return { ok: false, sent: 0 };
  }
}
