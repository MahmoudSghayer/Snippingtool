// Continuous audit log. Every finding is appended as one JSON line to
// qa/out/audit-log.jsonl with the fields the brief asks for (title,
// severity, location, steps, expected, actual, screenshot, suggested fix).
// Secrets are redacted before anything is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(dir, '..', 'out');
const LOG = path.join(OUT_DIR, 'audit-log.jsonl');
export const SCREENS_DIR = path.join(OUT_DIR, 'screens');

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category: 'security' | 'functional' | 'performance' | 'ux' | 'accessibility';
  location: string;
  steps: string;
  expected: string;
  actual: string;
  screenshot?: string;
  suggestedFix: string;
  target: string;
}

// Redact anything that looks like a token, cookie, key or bearer header.
const REDACTORS: Array<[RegExp, string]> = [
  [/(eyJ[A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt-redacted>'],
  [/(sl_(?:at|rt|csrf)=)[^;\s"']+/gi, '$1<redacted>'],
  [/(authorization:\s*bearer\s+)\S+/gi, '$1<redacted>'],
  [/(-----BEGIN [A-Z ]+KEY-----)[\s\S]*?(-----END [A-Z ]+KEY-----)/g, '$1<redacted>$2'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, to] of REDACTORS) out = out.replace(re, to);
  return out;
}

export function initAuditLog(): void {
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  // Truncate at the start of a run so each run's log stands alone.
  if (!process.env.QA_APPEND) fs.writeFileSync(LOG, '');
}

export function record(f: Finding): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const line = redact(JSON.stringify(f));
  fs.appendFileSync(LOG, line + '\n');
}

export function readFindings(): Finding[] {
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Finding);
  } catch {
    return [];
  }
}
