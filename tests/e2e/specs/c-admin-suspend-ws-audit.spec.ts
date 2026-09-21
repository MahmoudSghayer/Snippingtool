// Journey (c): admin TOTP login -> suspend a user (audit row with a real
// before/after diff, revokes sessions in the DB) -> force-logout the same,
// already-suspended user (its live WS connection still receives
// `session.revoked`) -> both actions show up in the audit log.
//
// Note on scope and ordering — defect #7 (docs/12-testing.md "Defects
// found"), FIXED: `POST /admin/users/:id/suspend` itself only revokes
// sessions in the database (docs/03-api.md's route table does not claim it
// pushes anything over WS, and apps/api/src/modules/admin-users/index.ts's
// suspend handler calls `revokeAllUserSessions` — a plain DB update, no
// `publishToUser` call at all) — only `force-logout` pushes
// `session.revoked`. Calling suspend *then* force-logout on the same
// target — this suite's order, and the natural admin workflow order ("shut
// the account down completely, then make sure they're actually kicked
// off") — used to leave force-logout's own `revokeAllUserSessions` call
// with nothing left to revoke (suspend already did), so its WS push
// silently never fired: 200 OK, zero sessions revoked, zero pushes, no
// error anywhere. Fixed by having force-logout report `sessionsRevoked`
// explicitly (now legitimately 0 in this exact scenario — asserted below,
// not hidden) and push `session.revoked` for every session id the target
// has ever had regardless of that count, so the live WS connection this
// spec opens *before* either admin action still gets notified.
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';

import { bearer, createAdminSession, registerAndLogin } from '../helpers/auth.js';
import { connect, deleteUsersByEmailPrefix } from '../helpers/db.js';
import { API_ORIGIN } from '../playwright.config.js';

const ADMIN_EMAIL = `e2e-journey-c-admin-${Date.now()}@example.com`;
const TARGET_EMAIL = `e2e-journey-c-target-${Date.now()}@example.com`;

test.afterAll(async () => {
  const db = connect();
  try {
    await deleteUsersByEmailPrefix(db, 'e2e-journey-c-');
  } finally {
    await db.end({ timeout: 5 });
  }
});

function wsUrl(ticket: string): string {
  return `${API_ORIGIN.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`;
}

test('admin TOTP login -> suspend (audited, before/after) -> force-logout on the already-suspended account (WS session.revoked) -> audit trail has both', async ({
  request,
}) => {
  const admin =
    await test.step('admin TOTP login (register + promote + real enrollment flow)', () =>
      createAdminSession(API_ORIGIN, ADMIN_EMAIL, 'journey-c-admin'));
  const target = await test.step('target user registers, verifies, logs in', () =>
    registerAndLogin(API_ORIGIN, TARGET_EMAIL, 'journey-c-target'));

  let ticket = '';
  await test.step('target opens a WS ticket for its own live connection', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/ws/ticket`, {
      headers: bearer(target.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    ({ ticket } = (await res.json()) as { ticket: string });
  });

  const socket = new WebSocket(wsUrl(ticket));
  const seenMessages: string[] = [];
  const revokedEvent = new Promise<{ type: string; sessionId: string; reason: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for session.revoked over WS (messages seen: ${JSON.stringify(seenMessages)}, readyState: ${socket.readyState})`,
            ),
          ),
        20_000,
      );
      socket.on('message', (raw) => {
        seenMessages.push(raw.toString());
        const event = JSON.parse(raw.toString()) as {
          type: string;
          sessionId: string;
          reason: string;
        };
        if (event.type === 'session.revoked') {
          clearTimeout(timer);
          resolve(event);
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on('close', (code, reason) => {
        seenMessages.push(`[closed: code=${code} reason=${reason.toString()}]`);
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  await test.step('admin suspends the target (audited with a real before/after diff) — revokes the session in the DB, pushes nothing over WS itself', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/admin/users/${target.userId}/suspend`, {
      headers: bearer(admin.accessToken),
      data: { reason: 'e2e journey (c): suspend half' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('suspended');
  });

  await test.step("the target's account is now suspended — 403, not the stale-token 401", async () => {
    // `plugins/auth.ts`'s `resolveAuthUser` checks `user.status ===
    // 'suspended'` *before* the row_version-staleness check, so a suspended
    // account's already-stale token gets the more specific `FORBIDDEN`
    // (403) instead of `AUTH_SESSION_REVOKED` (401).
    const res = await request.get(`${API_ORIGIN}/api/v1/users/me`, {
      headers: bearer(target.accessToken),
    });
    expect(res.status()).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'FORBIDDEN' });
  });

  // The actual defect #7 regression check: force-logout on an account
  // suspend already fully revoked in the DB. Before the fix this was a
  // silent no-op (200, zero sessions revoked, zero WS pushes, nothing to
  // catch it); now it explicitly reports 0 revoked while still notifying
  // the still-open WS connection.
  await test.step('admin force-logs-out the already-suspended target -> sessionsRevoked is 0, but the live WS connection still gets session.revoked', async () => {
    const res = await request.post(
      `${API_ORIGIN}/api/v1/admin/users/${target.userId}/force-logout`,
      {
        headers: bearer(admin.accessToken),
        data: { reason: 'e2e journey (c): force-logout half' },
      },
    );
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      sessionsRevoked: number;
      sessionsNotified: number;
    };
    expect(body.sessionsRevoked).toBe(0); // suspend already revoked the only session
    expect(body.sessionsNotified).toBeGreaterThanOrEqual(1); // still notified regardless

    const event = await revokedEvent;
    expect(event.reason).toBe('admin_force_logout');
    expect(event.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    socket.close();
  });

  await test.step('the audit log has both actions, each with the admin as actor and a request id', async () => {
    const res = await request.get(
      `${API_ORIGIN}/api/v1/admin/audit?entityId=${target.userId}&limit=50`,
      { headers: bearer(admin.accessToken) },
    );
    expect(res.status(), await res.text()).toBe(200);
    const entries = (await res.json()) as Array<{
      action: string;
      actorId: string | null;
      before: unknown;
      after: unknown;
      requestId: string | null;
    }>;

    const suspended = entries.find((e) => e.action === 'user.suspended');
    expect(suspended, JSON.stringify(entries)).toBeTruthy();
    expect(suspended!.actorId).toBe(admin.userId);
    expect(suspended!.before).toMatchObject({ status: 'active' });
    expect(suspended!.after).toMatchObject({ status: 'suspended' });
    expect(suspended!.requestId).toBeTruthy();

    const forceLoggedOut = entries.find((e) => e.action === 'user.force_logout');
    expect(forceLoggedOut, JSON.stringify(entries)).toBeTruthy();
    expect(forceLoggedOut!.actorId).toBe(admin.userId);
    // Defect #7: this used to be asserted >= 1 (from the reordered,
    // defect-avoiding version of this spec) — now explicitly 0, and that's
    // exactly the point: the response is meaningful either way, and
    // sessionsNotified (checked above, over the real WS socket) is what
    // proves the user still got told.
    expect((forceLoggedOut!.after as { sessionsRevoked: number }).sessionsRevoked).toBe(0);
  });
});
