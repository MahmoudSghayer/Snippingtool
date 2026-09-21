// k6: POST /extension/heartbeat — every ~10min in real usage per device
// (docs/03-api.md "extension"), but the endpoint itself is cheap and
// frequently-called-enough-in-aggregate (every online device, every
// deployment) to be worth its own load scenario independent of the
// heavier activity-ingest batches.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

import { BASE_URL, jsonHeaders, scenarioOptions, thresholds } from '../lib/config.js';

const users = new SharedArray('users', () => JSON.parse(open('../.artifacts/fixtures.json')).users);

export const options = { ...scenarioOptions(), thresholds: thresholds({ http_req_duration: ['p(95)<600'] }) };

export default function () {
  const user = users[__VU % users.length];
  if (!user.deviceId) {
    // provision.mjs couldn't resolve a deviceId for this user (e.g. GET
    // /devices returned nothing unexpected) — skip rather than send a
    // request guaranteed to 400/404 and pollute the error-rate threshold
    // with a fixture problem instead of a server one.
    sleep(1);
    return;
  }
  const res = http.post(
    `${BASE_URL}/api/v1/extension/heartbeat`,
    JSON.stringify({ deviceId: user.deviceId, extensionVersion: '0.1.0', engineState: 'running' }),
    { headers: { ...jsonHeaders(), authorization: `Bearer ${user.accessToken}` } },
  );
  check(res, {
    '200': (r) => r.status === 200,
    'has killSwitchActive': (r) => {
      try {
        return typeof JSON.parse(r.body).killSwitchActive === 'boolean';
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
