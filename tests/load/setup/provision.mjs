#!/usr/bin/env node
// Provisions the fixture users k6 needs before a load run (k6 itself has no
// database access and no `fetch`/npm-module story — this is a plain Node
// script, run once with `pnpm load:provision` or automatically by
// `load/run.mjs`). Writes tests/load/.artifacts/fixtures.json (gitignored —
// contains a real, if fake-data, password and tokens).
//
// Mirrors tests/e2e/helpers/auth.ts's approach (register through the real
// API, verify by a direct DB write — see that file's header for why) but
// standalone (no Playwright), and additionally logs every regular user in
// once up front (load scripts spend their whole run *using* a session, not
// creating one — auth-login-refresh.js is the one scenario that logs in
// itself, on its own fresh users, to load-test login specifically).
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authenticator } from 'otplib';
import postgres from 'postgres';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.join(dirname, '..', '.artifacts');
const outFile = path.join(artifactsDir, 'fixtures.json');

const BASE_URL = (process.env.LOAD_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
const PASSWORD = 'correcthorsebattery12';
const POOL_SIZE = Number(process.env.LOAD_USER_POOL_SIZE || 25);
const RUN_TAG = process.env.LOAD_RUN_TAG || Date.now().toString(36);

function device(seed) {
  return { fingerprint: `load-${seed}-${'x'.repeat(24)}`.slice(0, 64), name: 'k6 load fixture', browser: 'chrome', os: 'linux', extensionVersion: '0.1.0' };
}

async function postJson(pathName, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`POST ${pathName} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  console.warn(`[load/provision] registering ${POOL_SIZE} users + 1 admin against ${BASE_URL} (run tag ${RUN_TAG})...`);
  const db = postgres(DATABASE_URL, { max: 4 });

  try {
    // --- regular user pool (activity-ingest.js, extension-heartbeat.js,
    // profits-queries.js all read from this) ---
    const users = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const email = `load-${RUN_TAG}-user-${i}@example.test`;
      const { userId } = await postJson('/api/v1/auth/register', { email, password: PASSWORD, device: device(`u${i}`) });
      await db`update users set email_verified_at = now() where id = ${userId}`;
      const login = await postJson('/api/v1/auth/login', { email, password: PASSWORD, device: device(`u${i}`) });
      // A trial gives the account a device/subscription shape closer to a
      // real paying-ish user (profits-queries.js reads /profits, which
      // works with no subscription too, but this is more representative).
      await postJson('/api/v1/subscriptions/trial', {}, { authorization: `Bearer ${login.accessToken}` }).catch(() => null);

      const devicesRes = await fetch(`${BASE_URL}/api/v1/devices`, { headers: { authorization: `Bearer ${login.accessToken}` } });
      const devices = await devicesRes.json();
      const deviceId = Array.isArray(devices) ? (devices.find((d) => d.isCurrent)?.id ?? devices[0]?.id ?? null) : null;

      users.push({ email, password: PASSWORD, userId, deviceId, accessToken: login.accessToken, refreshToken: login.refreshToken });
    }

    // --- admin (admin-analytics-overview.js) — real TOTP enrollment via the
    // actual routes, same as tests/e2e/helpers/auth.ts#createAdminSession,
    // standalone here since this script has no Playwright/db.ts to import
    // from (k6 fixtures must be plain JSON, not TS module exports). ---
    const adminEmail = `load-${RUN_TAG}-admin@example.test`;
    const adminDevice = device('admin');
    const { userId: adminUserId } = await postJson('/api/v1/auth/register', { email: adminEmail, password: PASSWORD, device: adminDevice });
    await db`update users set email_verified_at = now(), role = 'admin' where id = ${adminUserId}`;
    await db`insert into admin_users (id, user_id, admin_role, permissions) values (${randomUUID()}, ${adminUserId}, 'super_admin', '{}'::jsonb)
               on conflict (user_id) do update set admin_role = excluded.admin_role, deleted_at = null`;

    const adminLogin = await postJson('/api/v1/auth/login', { email: adminEmail, password: PASSWORD, device: adminDevice });
    if (adminLogin.status !== 'mfa_required') throw new Error(`expected admin bootstrap-enrollment ticket, got: ${JSON.stringify(adminLogin)}`);
    const enroll = await postJson('/api/v1/auth/totp/enroll', { mfaTicket: adminLogin.mfaTicket });
    const confirm = await postJson('/api/v1/auth/totp/enroll/confirm', { mfaTicket: adminLogin.mfaTicket, code: authenticator.generate(enroll.secret) });
    if (!confirm.tokens) throw new Error(`admin TOTP enroll/confirm did not return tokens: ${JSON.stringify(confirm)}`);

    // --- a second, disjoint pool of users dedicated to
    // auth-login-refresh.js. Every regular login bumps users.row_version as
    // a side effect of its own benign last_login_at/last_ip bookkeeping
    // (apps/api/src/modules/auth/service.ts's own comment on this — a
    // deliberate, documented trigger side effect, not a bug), which
    // immediately invalidates any *other* already-issued access token for
    // that same account (its `ver` claim goes stale). auth-login-refresh.js
    // logs in repeatedly against a random user from whichever pool it
    // reads; sharing the main `users` pool with it would non-deterministically
    // invalidate the cached `accessToken`s activity-ingest.js/
    // extension-heartbeat.js/profits-queries.js rely on (reproduced while
    // authoring this script: a shared-pool run failed extension-heartbeat.js
    // and profits-queries.js checks for exactly the users
    // auth-login-refresh.js happened to log into first, with a real
    // AUTH_SESSION_REVOKED, not a fixture bug — see docs/12-testing.md
    // "Defects found" / "tests/load notes").
    const authUsers = [];
    const AUTH_POOL_SIZE = Math.min(POOL_SIZE, 15);
    for (let i = 0; i < AUTH_POOL_SIZE; i += 1) {
      const email = `load-${RUN_TAG}-authuser-${i}@example.test`;
      const { userId } = await postJson('/api/v1/auth/register', { email, password: PASSWORD, device: device(`a${i}`) });
      await db`update users set email_verified_at = now() where id = ${userId}`;
      authUsers.push({ email, userId });
    }

    mkdirSync(artifactsDir, { recursive: true });
    const fixtures = {
      runTag: RUN_TAG,
      baseUrl: BASE_URL,
      provisionedAt: new Date().toISOString(),
      password: PASSWORD,
      users,
      authUsers,
      admin: { email: adminEmail, userId: adminUserId, accessToken: confirm.tokens.accessToken, refreshToken: confirm.tokens.refreshToken },
    };
    writeFileSync(outFile, JSON.stringify(fixtures, null, 2));
    console.warn(`[load/provision] wrote ${users.length} users + ${authUsers.length} auth-only users + 1 admin -> ${path.relative(process.cwd(), outFile)}`);
  } finally {
    await db.end({ timeout: 5 });
  }
}

await main();
