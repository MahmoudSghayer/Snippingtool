// k6: GET /profits — the user-facing profit rollup query (docs/03-api.md
// "activity / sniping / trades / profits / filters / risk-events"), read on
// every dashboard visit and every popup open. Exercises all four
// granularities in rotation since the daily/weekly/monthly/lifetime paths
// aggregate the same underlying `profits` rollup table differently
// (application-code aggregation for the coarser three — see that route's
// doc comment) and so have different cost profiles worth seeing separately
// in the summary, not just as one averaged number.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

import { BASE_URL, scenarioOptions, thresholds } from '../lib/config.js';

const users = new SharedArray('users', () => JSON.parse(open('../.artifacts/fixtures.json')).users);
const GRANULARITIES = ['daily', 'weekly', 'monthly', 'lifetime'];

export const options = { ...scenarioOptions(), thresholds: thresholds({ http_req_duration: ['p(95)<1000'] }) };

export default function () {
  const user = users[__VU % users.length];
  const granularity = GRANULARITIES[__ITER % GRANULARITIES.length];
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const res = http.get(`${BASE_URL}/api/v1/profits?from=${from}&to=${to}&granularity=${granularity}`, {
    headers: { authorization: `Bearer ${user.accessToken}` },
    tags: { granularity },
  });
  check(res, {
    '200': (r) => r.status === 200,
    'has items array': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
