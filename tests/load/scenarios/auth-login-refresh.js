// k6: POST /auth/login -> POST /auth/refresh, per iteration, against
// tests/load/setup/provision.mjs's *dedicated* `authUsers` pool — a
// separate set of accounts from the `users` pool the other four scenarios
// share. Deliberately disjoint (see provision.mjs's own comment on
// `authUsers` for the full explanation): every login bumps
// `users.row_version` as a side effect of its own benign
// last_login_at/last_ip bookkeeping, which invalidates any *other*
// already-issued access token for that same account. Sharing one pool
// across "the scenario that logs in a lot" and "the scenarios that hold a
// cached access token for the whole run" would non-deterministically
// invalidate the other scenarios' tokens.
//
// Runs login+refresh (not just login) because refresh's rotation-with-
// reuse-detection is the more expensive/lock-sensitive of the two paths
// (docs/04-auth.md) — a login-only load test would under-represent real
// traffic (the extension refreshes on every 401 and every ~10min heartbeat
// cycle far more often than a user actually logs in).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

import { BASE_URL, jsonHeaders, scenarioOptions, thresholds } from '../lib/config.js';

const fixtures = new SharedArray('authUsers', () => JSON.parse(open('../.artifacts/fixtures.json')).authUsers);
const PASSWORD = JSON.parse(open('../.artifacts/fixtures.json')).password;

export const options = { ...scenarioOptions(), thresholds: thresholds() };

export default function () {
  const user = fixtures[Math.floor(Math.random() * fixtures.length)];
  // Fixed per-user fingerprint (not per-VU): every trial account has a
  // device limit of 1 (docs/05-subscriptions.md §1), so many VUs logging
  // into the *same* pooled user with *different* fingerprints would 409
  // DEVICE_LIMIT_REACHED on each other. Matches provision.mjs's
  // `device('a' + i)` seed for this exact pool.
  const device = { fingerprint: `load-a${fixtures.indexOf(user)}-${'x'.repeat(24)}`.slice(0, 64) };

  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({ email: user.email, password: PASSWORD, device }), { headers: jsonHeaders() });
  const loginOk = check(loginRes, {
    'login: 200': (r) => r.status === 200,
    'login: status ok': (r) => {
      try {
        return JSON.parse(r.body).status === 'ok';
      } catch {
        return false;
      }
    },
  });

  if (loginOk) {
    const { refreshToken } = JSON.parse(loginRes.body);
    const refreshRes = http.post(`${BASE_URL}/api/v1/auth/refresh`, JSON.stringify({ refreshToken }), { headers: jsonHeaders() });
    check(refreshRes, {
      'refresh: 200': (r) => r.status === 200,
      'refresh: got a new access token': (r) => {
        try {
          return typeof JSON.parse(r.body).accessToken === 'string';
        } catch {
          return false;
        }
      },
    });
  }

  sleep(1);
}
