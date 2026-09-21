// k6: POST /activity/batch — the extension's own batched telemetry ingest
// (docs/03-api.md "activity"), up to 500 events per call. Sends a modest
// batch of heartbeat+search events per iteration, one pooled user per VU
// (round-robin by __VU, not random, so a run's total request count is
// predictable from VUs*iterations rather than skewed by collisions).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

import { BASE_URL, jsonHeaders, scenarioOptions, thresholds } from '../lib/config.js';

const users = new SharedArray('users', () => JSON.parse(open('../.artifacts/fixtures.json')).users);

export const options = { ...scenarioOptions(), thresholds: thresholds({ http_req_duration: ['p(95)<1000'] }) };

function batch() {
  const now = () => new Date().toISOString();
  return {
    events: [
      { type: 'heartbeat', occurredAt: now(), metadata: { extensionVersion: '0.1.0', engineState: 'running' } },
      {
        type: 'search',
        occurredAt: now(),
        metadata: { filterHash: `k6-${Math.floor(Math.random() * 1e9)}`, resultsCount: Math.floor(Math.random() * 40), floorPrice: 1000 + Math.floor(Math.random() * 50000) },
      },
    ],
  };
}

export default function () {
  const user = users[__VU % users.length];
  const res = http.post(`${BASE_URL}/api/v1/activity/batch`, JSON.stringify(batch()), {
    headers: { ...jsonHeaders(), authorization: `Bearer ${user.accessToken}` },
  });
  check(res, {
    '200': (r) => r.status === 200,
    'accepted >= 1': (r) => {
      try {
        return JSON.parse(r.body).accepted >= 1;
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
