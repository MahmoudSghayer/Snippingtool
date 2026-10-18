/*
 * errors.ts — flushes `lib/logger.ts`'s ring buffer to `/extension/errors`.
 * Only `warn`/`error`-level entries are reported (matching what the logger
 * already echoes to the console), each one once; `message`/`stack`/
 * `context` only — never user input, never a listing, matching `extensionErrorReportSchema`
 * (packages/shared). Independent of the telemetry opt-out (error reports
 * are diagnostics about the extension itself, not product-usage telemetry —
 * see docs/06-extension.md, "What it sends" for the exact line this maps
 * to), but still local-only until a device is registered (no `deviceId` yet
 * means nothing to flush).
 */

import { apiJson } from './api.js';
import { exportLogs, type LogEntry } from './logger.js';

import type { ExtensionErrorReport } from '@sl/shared';

const EXTENSION_VERSION = import.meta.env.VITE_EXTENSION_VERSION;

function toReportEntry(entry: LogEntry): ExtensionErrorReport['errors'][number] {
  return {
    message: entry.message.slice(0, 2000),
    context: entry.context?.slice(0, 120),
    occurredAt: new Date(entry.at).toISOString(),
  };
}

/** The `seq` of the newest log entry already reported. Each entry is sent
 * once: the ring buffer is not cleared by a flush, and every flush used to
 * send its oldest 100 warnings again — every five minutes for as long as
 * they stayed in it, which multiplied every warning in the server's error
 * reports (and kept newer ones out of them). */
let reportedThroughSeq = 0;

export async function flushErrors(deviceId: string | null): Promise<{ ok: boolean; sent: number }> {
  if (!deviceId) return { ok: false, sent: 0 };
  const reportable = exportLogs().filter((e) => (e.level === 'warn' || e.level === 'error') && e.seq > reportedThroughSeq);
  if (reportable.length === 0) return { ok: true, sent: 0 };

  // Oldest first; whatever is left goes in the next flush.
  const batch = reportable.slice(0, 100);
  const body: ExtensionErrorReport = { deviceId, extensionVersion: EXTENSION_VERSION, errors: batch.map(toReportEntry) };
  try {
    await apiJson('/api/v1/extension/errors', { method: 'POST', body: JSON.stringify(body) });
    reportedThroughSeq = Math.max(reportedThroughSeq, batch[batch.length - 1]!.seq);
    return { ok: true, sent: batch.length };
  } catch {
    return { ok: false, sent: 0 };
  }
}
