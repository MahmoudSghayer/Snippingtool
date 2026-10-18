// Refresh-token reuse detection and its grace window (docs/04-auth.md §3):
// a superseded refresh token presented again revokes its whole session
// family, except a retry within 30 s of the rotation whose successor was
// never used (a client whose first answer was lost), which gets a fresh
// pair for the same family. These pin the boundary from the outside, and
// that a revoked family is never revived through the window.
//
// The 30 s is the documented window (`REFRESH_ROTATION_GRACE_MS` in
// @sl/api, which this package cannot import: it sees only `@sl/api/app`).
// "Time passing" is a backdated `revoked_at` on the rotated row.

import { createHash } from 'node:crypto';

import { sessions } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, createUserSession, nextIp, type TestApp } from './helpers.js';

const GRACE_MS = 30_000;

/** `sessions.refresh_token_hash`: SHA-256 hex of the opaque token. */
function tokenHash(presented: string): string {
  return createHash('sha256').update(presented, 'utf8').digest('hex');
}

describe('refresh-token reuse detection and the grace window (docs/04-auth.md §3)', () => {
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

  function refresh(ip: string, presented: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      payload: { refreshToken: presented },
    });
  }

  async function rotatedAgo(presented: string, ms: number) {
    const where = eq(sessions.refreshTokenHash, tokenHash(presented));
    const row = await app.db.query.sessions.findFirst({ where });
    expect(row?.revokedReason).toBe('rotated');
    await app.db
      .update(sessions)
      .set({ revokedAt: new Date(row!.revokedAt!.getTime() - ms) })
      .where(where);
  }

  async function liveSessionCount(userId: string): Promise<number> {
    const rows = await app.db.query.sessions.findMany({
      where: and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    });
    return rows.length;
  }

  it('a superseded token presented after the window revokes the family', async () => {
    const ip = nextIp();
    const session = await createUserSession(app, 'reuse-late@example.com', 'reuse-fp-000000000001');
    const rt2 = (await refresh(ip, session.refreshToken)).json().refreshToken as string;
    await rotatedAgo(session.refreshToken, GRACE_MS + 1_000);

    const reuse = await refresh(ip, session.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('AUTH_TOKEN_REUSED');
    expect(await liveSessionCount(session.userId)).toBe(0);
    expect((await refresh(ip, rt2)).statusCode).toBe(401);
  });

  it('a retry just inside the window gets a fresh pair, and the successor it replaces is dead', async () => {
    const ip = nextIp();
    const session = await createUserSession(
      app,
      'reuse-retry@example.com',
      'reuse-fp-000000000002',
    );
    const lost = (await refresh(ip, session.refreshToken)).json().refreshToken as string;
    await rotatedAgo(session.refreshToken, GRACE_MS - 2_000);

    const retry = await refresh(ip, session.refreshToken);
    expect(retry.statusCode).toBe(200);
    const fresh = retry.json().refreshToken as string;
    expect(fresh).not.toBe(lost);
    expect(await liveSessionCount(session.userId)).toBe(1);

    // The successor that was replaced is never accepted: presenting it is
    // reuse, and takes the family down.
    const replay = await refresh(ip, lost);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_TOKEN_REUSED');
    expect((await refresh(ip, fresh)).statusCode).toBe(401);
  });

  it('a replay inside the window after the successor was used is reuse', async () => {
    const ip = nextIp();
    const session = await createUserSession(app, 'reuse-used@example.com', 'reuse-fp-000000000003');
    const rt2 = (await refresh(ip, session.refreshToken)).json().refreshToken as string;
    expect((await refresh(ip, rt2)).statusCode).toBe(200);

    const replay = await refresh(ip, session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_TOKEN_REUSED');
    expect(await liveSessionCount(session.userId)).toBe(0);
  });

  it('a logged-out session is not revived by a retry inside the window', async () => {
    const ip = nextIp();
    const session = await createUserSession(
      app,
      'reuse-logout@example.com',
      'reuse-fp-000000000004',
    );
    const rt2 = (await refresh(ip, session.refreshToken)).json().refreshToken as string;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      remoteAddress: ip,
      payload: { refreshToken: rt2 },
    });

    expect((await refresh(ip, session.refreshToken)).statusCode).toBe(401);
    expect(await liveSessionCount(session.userId)).toBe(0);
  });
});
