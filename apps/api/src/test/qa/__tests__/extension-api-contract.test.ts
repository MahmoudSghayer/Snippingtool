// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #4 ("Defects found"): the extension's
// settings sync sent `PATCH` to a route the server only ever registered
// `PUT` for, and every real request 404d. Fixing that one call site by
// hand doesn't prevent the *next* extension/server drift, so this test
// takes a different approach: it statically scans every literal
// `(method, path)` pair the extension's own HTTP helpers
// (`apiJson`/`apiFetch`/`retryFetch`/`telemetry.ts`'s `postBatch`) call
// with, across `apps/extension/src/lib` and `apps/extension/src/background`,
// and asserts each one is a route the API actually registers — cross-
// checked against the committed `apps/api/openapi/openapi.json`
// (`openapi-spec.test.ts`, alongside this file, already pins that document
// itself against the live app, so this test can trust it as ground truth).
//
// While writing this scanner it also caught three more, previously
// undocumented, real 404s in `apps/extension/src/lib/telemetry.ts`'s
// `flush()`: it posted to `/api/v1/activity`, `/api/v1/sniping` and
// `/api/v1/trades`, but the API only ever registers `/api/v1/activity/
// batch`, `/api/v1/sniping/attempts` and `/api/v1/trades/batch` — every
// activity/sniping/trade telemetry flush was silently 404ing (only
// filters/stats, risk-events and the extension/telemetry ping used a path
// that actually existed). Fixed alongside this test, in the same commit as
// the defect #4 settings fix.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(__dirname, '..', '..', '..', '..', 'openapi', 'openapi.json');
const EXTENSION_LIB_DIR = join(__dirname, '..', '..', '..', '..', '..', 'extension', 'src', 'lib');
const EXTENSION_BACKGROUND_DIR = join(__dirname, '..', '..', '..', '..', '..', 'extension', 'src', 'background');

interface MinimalOpenApiDoc {
  paths?: Record<string, Record<string, unknown> | undefined>;
}

interface ClientCall {
  file: string;
  method: string;
  path: string;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => join(dir, entry.name));
}

/** Finds the substring of `src` between the opening `(` at `openParenIdx`
 * and its matching `)`, tracking paren depth only (braces inside object
 * literals don't affect it) and skipping over string-literal contents so a
 * stray `(`/`)` inside a string never desyncs the count. */
function extractCallArgs(src: string, openParenIdx: number): string {
  let depth = 1;
  let i = openParenIdx + 1;
  let inString: string | null = null;
  const start = i;
  for (; i < src.length && depth > 0; i += 1) {
    const c = src[i];
    if (inString) {
      if (c === '\\') i += 1; // skip escaped char
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
  }
  return src.slice(start, i - 1);
}

/** Scans one file's source for every `fnName(...)` / `fnName<T>(...)` call
 * whose first argument is a string literal, and returns each as a
 * `{ method, path }` pair (method defaults to GET when the call has no
 * `method:` option, matching `fetch`'s own default and every helper here). */
function findClientCalls(file: string, fnNames: string[]): ClientCall[] {
  const src = readFileSync(file, 'utf8');
  const calls: ClientCall[] = [];
  const callRe = new RegExp(`\\b(?:${fnNames.join('|')})(?:<[^>(]*>)?\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src))) {
    const openParenIdx = callRe.lastIndex - 1;
    const args = extractCallArgs(src, openParenIdx);
    const pathMatch = /^\s*['"`]([^'"`]+)['"`]/.exec(args);
    if (!pathMatch) continue; // first arg isn't a string literal — a function definition or a dynamic path, not a call this scanner can check
    const path = pathMatch[1]!;
    if (!path.startsWith('/api/')) continue;
    const methodMatch = /method\s*:\s*['"](\w+)['"]/.exec(args);
    // telemetry.ts's postBatch() helper always POSTs (see its own body) —
    // its call sites never pass a `method:` option, they just pass the
    // path and a `{ key: value[] }` body shape, so the "no method: option
    // -> GET" default below would be wrong specifically for this one
    // helper.
    const method = (methodMatch?.[1] ?? (/^postBatch/.test(m[0]) ? 'POST' : 'GET')).toUpperCase();
    calls.push({ file, method, path });
  }
  return calls;
}

describe('extension API client vs. apps/api/openapi/openapi.json (defect #4 regression)', () => {
  const spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as MinimalOpenApiDoc;
  const registered = new Set<string>();
  for (const [routePath, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods) continue;
    for (const method of Object.keys(methods)) registered.add(`${method.toUpperCase()} ${routePath}`);
  }

  const files = [...listTsFiles(EXTENSION_LIB_DIR), ...listTsFiles(EXTENSION_BACKGROUND_DIR)];
  const calls = files.flatMap((file) => findClientCalls(file, ['apiJson', 'apiFetch', 'retryFetch', 'postBatch']));

  it('found a non-trivial number of literal API calls to check (scanner sanity check)', () => {
    // If this ever drops near zero, the scanner itself broke (a helper was
    // renamed, an import path changed) — not that the extension stopped
    // calling the API.
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('every literal (method, path) the extension client calls is a route apps/api actually registers', () => {
    const missing = calls
      .map((c) => ({ ...c, key: `${c.method} ${c.path}` }))
      .filter((c) => !registered.has(c.key));
    expect(
      missing,
      `extension call sites hitting a route apps/api does not register (would 404):\n${missing
        .map((c) => `  ${c.method} ${c.path}  (${c.file})`)
        .join('\n')}`,
    ).toEqual([]);
  });

  // Pin the specific call sites this test exists to guard, by name, so a
  // future refactor that accidentally drops one of these files from the
  // scan (e.g. renaming a helper the regex above doesn't know about) still
  // has an explicit assertion that fails instead of the scan silently
  // finding fewer calls.
  it.each([
    ['GET /api/v1/settings'],
    ['PUT /api/v1/settings'],
    ['POST /api/v1/auth/register'],
    ['POST /api/v1/auth/resend-verification'],
    ['POST /api/v1/auth/login'],
    ['POST /api/v1/auth/refresh'],
    ['POST /api/v1/auth/logout'],
    ['POST /api/v1/auth/mfa/verify'],
    ['GET /api/v1/devices'],
    ['POST /api/v1/extension/bootstrap'],
    ['POST /api/v1/extension/heartbeat'],
    ['POST /api/v1/extension/telemetry'],
    ['POST /api/v1/extension/errors'],
    ['POST /api/v1/activity/batch'],
    ['POST /api/v1/sniping/attempts'],
    ['POST /api/v1/trades/batch'],
    ['POST /api/v1/filters/stats'],
    ['POST /api/v1/risk-events'],
  ])('the extension client actually calls %s somewhere', (key) => {
    const found = calls.some((c) => `${c.method} ${c.path}` === key);
    expect(found, `expected to find a call to ${key} in ${EXTENSION_LIB_DIR} or ${EXTENSION_BACKGROUND_DIR}`).toBe(true);
  });
});
