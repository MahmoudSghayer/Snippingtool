// Shared k6 config: base URL + load profile (smoke/soak/stress) + per-scenario
// options + thresholds. See docs/12-testing.md "tests/load" and
// tests/load/README.md for how to select a profile and what each one means.
//
// k6 scripts run under k6's own JS runtime (Goja), not Node — no npm
// resolution, no TypeScript. `import ... from 'k6/http'` etc. resolve
// against k6's built-in modules only when the file is actually *run* by the
// k6 binary; that's also why this file (and every file under
// tests/load/scenarios, tests/load/lib) is excluded from this package's own
// `tsc`/`eslint` (see tests/tsconfig.json, eslint.config.js).
export const BASE_URL = (__ENV.LOAD_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');

/** smoke: a quick, always-safe correctness+latency check (few VUs, ~30s) —
 * the only profile this repo runs in CI (docs/12-testing.md, "CI runs
 * everything but load" — smoke is the one load-shaped exception, kept
 * short enough not to slow the pipeline down).
 * soak: sustained moderate load over a long duration, looking for
 * leaks/degradation/connection-pool exhaustion rather than a peak number.
 * stress: ramps well past expected peak to find the actual breaking point
 * and confirm it fails the way it should (429s/5xxs with clean recovery,
 * not a crash). */
const PROFILES = {
  smoke: { vus: 3, duration: '30s' },
  soak: { vus: 20, duration: __ENV.LOAD_SOAK_DURATION || '30m' },
  stress: {
    stages: [
      { duration: '1m', target: 20 },
      { duration: '3m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 0 },
    ],
  },
};

export const PROFILE = (__ENV.LOAD_PROFILE || 'smoke').toLowerCase();
if (!PROFILES[PROFILE]) {
  throw new Error(
    `Unknown LOAD_PROFILE "${PROFILE}" — expected one of: ${Object.keys(PROFILES).join(', ')}`,
  );
}

/** A scenario file calls this once for its default-exported `options`.
 * `overrides` lets a scenario tighten/loosen the shared profile shape for
 * its own endpoint (e.g. a stricter p95 for a cheap health-style read, a
 * looser one for a heavier ingest batch) without duplicating the whole
 * profile table. */
export function scenarioOptions(overrides = {}) {
  return { ...PROFILES[PROFILE], ...overrides };
}

/** Default thresholds per profile — a scenario can extend/override via its
 * own `thresholds` key alongside whatever `scenarioOptions()` returns. */
const THRESHOLDS = {
  smoke: { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'] },
  soak: { http_req_duration: ['p(95)<1200'], http_req_failed: ['rate<0.02'] },
  stress: { http_req_duration: ['p(95)<2500'], http_req_failed: ['rate<0.10'] },
};

export function thresholds(extra = {}) {
  return { ...THRESHOLDS[PROFILE], ...extra };
}

export function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}
