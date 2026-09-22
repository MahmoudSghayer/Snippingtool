/*
 * logger.ts — an in-memory ring buffer plus an export, backing the options
 * page's "Export logs" button and `lib/errors.ts`'s error-report flush.
 * Deliberately not persisted to `storage.local` by itself (that would be a
 * second, unbounded write path); a session that needs logs to survive a
 * background worker restart flushes them explicitly (see `background/errors.ts`).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  at: number;
}

const MAX_ENTRIES = 500;
let buffer: LogEntry[] = [];

function push(level: LogLevel, message: string, context?: string): void {
  buffer.push({ level, message, context, at: Date.now() });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  if (level === 'error' || level === 'warn') {
    // eslint-disable-next-line no-console -- the whole point of warn/error is visibility
    console[level](context ? `[ledger:${context}]` : '[ledger]', message);
  }
}

export const logger = {
  debug: (message: string, context?: string) => push('debug', message, context),
  info: (message: string, context?: string) => push('info', message, context),
  warn: (message: string, context?: string) => push('warn', message, context),
  error: (message: string, context?: string) => push('error', message, context),
};

export function exportLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer = [];
}
