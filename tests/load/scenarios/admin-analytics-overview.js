// k6: GET /admin/analytics/overview — the admin dashboard's own KPI
// overview panel (docs/08-analytics.md §2), read by every admin session on
// every page load. Single admin fixture (provision.mjs enrolls its TOTP for
// real) shared across every VU — this is a read, so sharing one bearer
// token across concurrent VUs is realistic (the same admin has the
// dashboard open in more than one tab) and avoids provisioning N admins
// just to load-test a GET.
import http from 'k6/http';
import { check, sleep } from 'k6';

import { BASE_URL, scenarioOptions, thresholds } from '../lib/config.js';

const fixtures = JSON.parse(open('../.artifacts/fixtures.json'));

export const options = { ...scenarioOptions(), thresholds: thresholds({ http_req_duration: ['p(95)<1500'] }) };

export default function () {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Note: 'day', not 'daily' — admin-analytics's granularity enum
  // (packages/shared/src/schemas/analytics.ts's analyticsRangeQuerySchema,
  // 'day'|'week'|'month'|'lifetime') is a *different* vocabulary from
  // /profits's ('daily'|'weekly'|'monthly'|'lifetime', schemas/trades.ts) —
  // a real, if minor, cross-endpoint naming inconsistency for what is
  // conceptually the same query param; see docs/12-testing.md "Defects
  // found".
  const res = http.get(`${BASE_URL}/api/v1/admin/analytics/overview?from=${from}&to=${to}&granularity=day`, {
    headers: { authorization: `Bearer ${fixtures.admin.accessToken}` },
  });
  check(res, {
    '200': (r) => r.status === 200,
    'not rate-limited': (r) => r.status !== 429,
  });
  sleep(1);
}
