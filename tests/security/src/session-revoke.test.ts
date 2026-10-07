// F3: revoking a single session must invalidate its access token immediately,
// not only once the (15 min user / 5 min admin) TTL lapses. resolveAuthUser
// now checks sessions.revoked_at by the token's sid.
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, type TestApp } from './helpers.js';

describe('F3 — targeted session revoke invalidates the access token immediately', () => {
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

  it('a revoked session\'s access token is rejected on the next request', async () => {
    const user = await createUserSession(app, 'revoke-me@example.com', 'fp-revoke-000000000001');
    const auth = bearer(user.accessToken);

    // The token works, and the session is listed.
    const before = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth });
    expect(before.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: auth });
    expect(list.statusCode).toBe(200);
    const current = (list.json() as Array<{ id: string }>)[0];
    expect(current?.id).toBeTruthy();

    // Revoke that session (bearer auth → CSRF is exempt by construction).
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${current!.id}`,
      headers: auth,
    });
    expect([200, 204]).toContain(del.statusCode);

    // The same access token must no longer authenticate.
    const after = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth });
    expect(after.statusCode, 'access token must be rejected after its session is revoked').toBe(401);
  });

  it('an unrelated user\'s valid session is unaffected', async () => {
    const a = await createUserSession(app, 'keep-a@example.com', 'fp-keep-a-00000000001');
    const b = await createUserSession(app, 'keep-b@example.com', 'fp-keep-b-00000000001');
    // Revoke A's session; B must still work.
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(a.accessToken) });
    const aSession = (list.json() as Array<{ id: string }>)[0]!;
    await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${aSession.id}`, headers: bearer(a.accessToken) });

    const bOk = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: bearer(b.accessToken) });
    expect(bOk.statusCode, 'another user\'s session stays valid').toBe(200);
  });
});
