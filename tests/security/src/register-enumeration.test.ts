// F4: POST /auth/register must not reveal whether an email already exists.
// A duplicate registration returns the same neutral 2xx shape as a new one
// (previously a 409 "account already exists"), and the real owner is told out
// of band with an "account exists" email. Mirrors resendVerification /
// requestPasswordReset, which are deliberately non-revealing.
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, device, nextIp, TEST_PASSWORD, type TestApp } from './helpers.js';

async function register(app: TestApp, email: string, fp: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: nextIp(),
    payload: { email, password: TEST_PASSWORD, device: device(fp), acceptTerms: true },
  });
}

describe('F4 — register does not enumerate accounts', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('a duplicate registration is indistinguishable from a new one', async () => {
    const email = 'enum-target@example.com';
    const first = await register(app, email, 'fp-enum-first-00000001');
    expect(first.statusCode).toBe(201);

    const second = await register(app, email, 'fp-enum-second-0000001');
    // Same status and same response shape — no 409, no "already exists" message.
    expect(second.statusCode, 'duplicate register must not 409').toBe(201);
    const body = second.json() as { userId?: string };
    expect(body.userId, 'duplicate register returns the same { userId } shape').toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(JSON.stringify(second.json()).toLowerCase()).not.toContain('already exists');
  });

  it('the real owner is notified out of band, and no second account is created', async () => {
    const email = 'enum-notify@example.com';
    await register(app, email, 'fp-enum-n1-000000001');
    app.mailer.sentEmails.length = 0; // drop the first verification email
    await register(app, email, 'fp-enum-n2-000000001');

    const existsMail = app.mailer.sentEmails.find((m) => m.to === email && /already have/i.test(m.subject + m.text));
    expect(existsMail, 'an account-exists email is sent to the owner').toBeTruthy();

    // Exactly one user row for that email.
    const rows = await app.db.query.users.findMany({ columns: { id: true, email: true } });
    expect(rows.filter((u) => u.email === email).length, 'no duplicate account created').toBe(1);
  });
});
