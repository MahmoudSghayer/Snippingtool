#!/usr/bin/env node
// Minimal fallback load runner for when k6 genuinely cannot be installed
// (see run.mjs's header). Covers the same handful of endpoints each
// scenarios/*.js covers, with the same smoke-profile p95/error thresholds
// (tests/load/lib/config.js's numbers, duplicated here in plain JS since
// this file never runs through k6) — it does not reproduce k6's staged
// ramp-up (soak/stress profiles just run the smoke-shaped connection count
// for longer/shorter; good enough to notice "something is badly broken",
// not a substitute for a real k6 stress run). Prefer k6 whenever it's
// available at all — see tests/load/README.md "Installing k6".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import autocannon from 'autocannon';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const [scenario, profile, summaryPath] = process.argv.slice(2);

const BASE_URL = (process.env.LOAD_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const fixtures = JSON.parse(
  readFileSync(path.join(dirname, '.artifacts', 'fixtures.json'), 'utf8'),
);

const DURATIONS = { smoke: 15, soak: 120, stress: 60 };
const CONNECTIONS = { smoke: 5, soak: 20, stress: 50 };

const REQUESTS_BY_SCENARIO = {
  'auth-login-refresh': () => {
    const u = fixtures.users[0];
    return {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: u.email,
        password: fixtures.password,
        device: { fingerprint: 'autocannon-fallback-000000000001' },
      }),
    };
  },
  'activity-ingest': () => {
    const u = fixtures.users[Math.floor(Math.random() * fixtures.users.length)];
    return {
      method: 'POST',
      path: '/api/v1/activity/batch',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${u.accessToken}` },
      body: JSON.stringify({
        events: [
          {
            type: 'heartbeat',
            occurredAt: new Date().toISOString(),
            metadata: { extensionVersion: '0.1.0' },
          },
        ],
      }),
    };
  },
  'extension-heartbeat': () => {
    const u = fixtures.users[Math.floor(Math.random() * fixtures.users.length)];
    return {
      method: 'GET',
      path: '/api/v1/extension/kill-switch',
      headers: { authorization: `Bearer ${u.accessToken}` },
    };
  },
  'admin-analytics-overview': () => ({
    method: 'GET',
    path: '/api/v1/admin/system/health',
    headers: { authorization: `Bearer ${fixtures.admin.accessToken}` },
  }),
  'profits-queries': () => {
    const u = fixtures.users[Math.floor(Math.random() * fixtures.users.length)];
    return {
      method: 'GET',
      path: '/api/v1/profits?from=2026-01-01&to=2026-12-31&granularity=daily',
      headers: { authorization: `Bearer ${u.accessToken}` },
    };
  },
};

const buildRequest = REQUESTS_BY_SCENARIO[scenario];
if (!buildRequest) {
  console.error(`[autocannon-fallback] unknown scenario "${scenario}"`);
  process.exit(1);
}

const instance = autocannon({
  url: BASE_URL,
  connections: CONNECTIONS[profile] ?? CONNECTIONS.smoke,
  duration: DURATIONS[profile] ?? DURATIONS.smoke,
  setupClient: (client) => {
    const req = buildRequest();
    client.setHeaders(req.headers || {});
  },
  requests: [{ method: 'GET', path: '/' }], // overridden per-request below via a single fixed request shape
});

// autocannon's per-connection `requests` array needs a static shape; build
// it directly instead of via setupClient for methods/bodies that vary.
instance.opts.requests = [buildRequest()];

autocannon.track(instance, { renderProgressBar: false });

instance.on('done', (result) => {
  const p95 = result.latency.p97_5 ?? result.latency.p99; // autocannon's histogram doesn't expose p95 directly on every version
  const errorRate =
    (result.errors + result['4xx'] + result['5xx']) / Math.max(1, result.requests.total);
  const summary = {
    scenario,
    profile,
    engine: 'autocannon-fallback',
    requests: result.requests.total,
    p95Ms: p95,
    errorRate,
    thresholdsPassed: p95 < 800 && errorRate < 0.05,
  };
  console.warn(JSON.stringify(summary, null, 2));
  if (summaryPath) {
    import('node:fs').then(({ writeFileSync }) =>
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2)),
    );
  }
  process.exitCode = summary.thresholdsPassed ? 0 : 1;
});
