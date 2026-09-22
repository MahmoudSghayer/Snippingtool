import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, createAdminSession, createUserSession, type TestApp } from './helpers.js';

describe('security-tests smoke test', () => {
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

  it('boots the real app and answers /health/live', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('createUserSession produces a working bearer session', async () => {
    const session = await createUserSession(
      app,
      'smoke-user@example.com',
      'smoke-fp-0000000000000001',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(session.userId);
  });

  it('createAdminSession produces a working admin bearer session', async () => {
    const session = await createAdminSession(
      app,
      'super_admin',
      'smoke-admin@example.com',
      'smoke-fp-0000000000000002',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
