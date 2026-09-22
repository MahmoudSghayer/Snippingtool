// Injection payload suite (docs/09-security.md "No string-interpolated
// SQL"): every query in this app goes through Drizzle's query builder (or
// `sql.raw()` fed a constant string + separately-bound params — see
// `packages/config/eslint-preset.js`'s `no-restricted-syntax` rule and
// `.github/semgrep/rules.yml`'s `no-raw-sql-string-interpolation` static
// check), so a hostile
// string can never become SQL syntax no matter where it enters. These tests
// prove that at runtime: classic SQLi/NoSQLi/command-injection payloads sent
// through real request bodies must never 500 (a crash would mean the
// payload broke something it shouldn't have reached), must either validate
// cleanly and round-trip byte-for-byte (proving parameterisation — the
// payload is just data) or be rejected by schema validation with an
// ordinary 400 — never anything in between.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bearer,
  buildTestApp,
  createUserSession,
  TEST_PASSWORD,
  nextIp,
  type TestApp,
} from './helpers.js';

const SQLI_PAYLOADS = [
  `'; DROP TABLE users; --`,
  `' OR '1'='1`,
  `1; SELECT pg_sleep(5); --`,
  `x' UNION SELECT password_hash FROM users --`,
  `"; DELETE FROM saved_filters WHERE "1"="1`,
];

const XSS_PAYLOADS = [
  `<script>alert(document.cookie)</script>`,
  `<img src=x onerror=alert(1)>`,
  `"><svg onload=alert(1)>`,
];

const NOSQL_PAYLOADS: unknown[] = [{ $ne: null }, { $gt: '' }, ['$ne', null]];

describe('injection payload suite', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it.each(SQLI_PAYLOADS)(
    'SQLi payload %s in a saved filter name: stored and returned verbatim, never breaks the query (proves parameterisation)',
    async (payload) => {
      const user = await createUserSession(
        app,
        `sqli-${SQLI_PAYLOADS.indexOf(payload)}@example.com`,
        `sqli-fp-${SQLI_PAYLOADS.indexOf(payload)}-000000001`,
      );

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/filters',
        headers: bearer(user.accessToken),
        payload: { name: payload, filter: {} },
      });
      expect(createRes.statusCode).toBe(201);
      expect(createRes.json().name).toBe(payload);

      // The users table (a plausible DROP/injection target above) is
      // untouched — still exactly the one row this test itself created.
      const usersCount = await app.db.query.users.findMany();
      expect(usersCount.length).toBe(1);

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/filters',
        headers: bearer(user.accessToken),
      });
      expect(listRes.statusCode).toBe(200);
      expect((listRes.json() as Array<{ name: string }>).some((f) => f.name === payload)).toBe(
        true,
      );
    },
  );

  it.each(XSS_PAYLOADS)(
    'XSS payload %s in a saved filter name: stored and returned as inert JSON data, never executed server-side, never 500s',
    async (payload) => {
      const idx = XSS_PAYLOADS.indexOf(payload);
      const user = await createUserSession(
        app,
        `xss-${idx}@example.com`,
        `xss-fp-${idx}-00000000000001`,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/filters',
        headers: bearer(user.accessToken),
        payload: { name: payload, filter: {} },
      });
      expect(res.statusCode).toBe(201);
      // JSON response — the browser-side XSS risk this would carry only
      // exists if a consumer renders it unescaped (the dashboard/extension's
      // job, see docs/09-security.md "XSS"); the API's own contract is just
      // to store and return the exact bytes, never interpret them.
      expect(res.json().name).toBe(payload);
    },
  );

  it.each(SQLI_PAYLOADS)(
    'SQLi payload %s as a login email: rejected by schema validation (400), never reaches the query, never 500s',
    async (payload) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextIp(),
        payload: {
          email: payload,
          password: TEST_PASSWORD,
          device: { fingerprint: 'x'.repeat(20) },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    },
  );

  it.each(NOSQL_PAYLOADS)(
    'NoSQL/object-injection-style payload as a login password: rejected by schema validation (400), never 500s (type confusion never reaches argon2/Drizzle)',
    async (payload) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextIp(),
        payload: {
          email: 'nosql-target@example.com',
          password: payload,
          device: { fingerprint: 'x'.repeat(20) },
        },
      });
      expect(res.statusCode).toBe(400);
    },
  );

  it('a SQLi payload as a pagination cursor never reaches SQL: decodeCursor() treats it as undecodable and the route falls back to the first page, never a 500', async () => {
    const user = await createUserSession(
      app,
      'sqli-cursor@example.com',
      'sqli-cursor-fp-0000000000001',
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trades?cursor=${encodeURIComponent(`' OR '1'='1`)}`,
      headers: bearer(user.accessToken),
    });
    // apps/api/src/lib/pagination.ts's decodeCursor() never throws on a
    // malformed/hostile cursor (base64url-decode + JSON.parse, wrapped in
    // try/catch) — an undecodable cursor is treated exactly like "no
    // cursor" and the route serves the first page. That's the documented,
    // safe behaviour (the SQLi payload never reaches a query in any form),
    // so this asserts a clean 200 with the normal page shape, not a 500.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('items');
  });

  it('a path-traversal / non-UUID payload as a :id param is rejected by param validation (400), never reaches the query', async () => {
    const user = await createUserSession(
      app,
      'traversal@example.com',
      'traversal-fp-0000000000001',
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${encodeURIComponent('../../../etc/passwd')}`,
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('an oversize payload (well past every documented .max()) is rejected, not accepted or crashed on', async () => {
    const user = await createUserSession(app, 'oversize@example.com', 'oversize-fp-00000000000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/filters',
      headers: bearer(user.accessToken),
      payload: { name: 'x'.repeat(10_000), filter: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
