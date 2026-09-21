// Journey (c): admin TOTP login -> force-logout a user (its live WS
// connection receives `session.revoked`) -> suspend the same user (audit
// row with a real before/after diff) -> both actions show up in the audit
// log.
//
// Note on scope and ordering: `POST /admin/users/:id/suspend` itself only
// revokes sessions in the database (docs/03-api.md's route table does not
// claim it pushes anything over WS, and apps/api/src/modules/admin-users/
// index.ts's suspend handler calls `revokeAllUserSessions` — a plain DB
// update, no `publishToUser` call at all) — only `force-logout` actually
// pushes `session.revoked` (see that same file). Both routes' own
// `revokeAllUserSessions` call only WS-pushes for sessions it finds still
// active (`WHERE revoked_at IS NULL`); calling suspend *then* force-logout
// on the same target — this suite's original order — leaves force-logout's
// own call with nothing left to revoke (suspend already did), so its WS
// push silently never fires: 200 OK, zero sessions revoked, zero pushes,
// no error anywhere (reproduced while authoring this spec). Force-logout
// runs first here so its own revoke has a genuinely active session to work
// on; suspend runs second, still against the real, already-force-logged-out
// account, for the audited before/after half.
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

test('admin TOTP login -> suspend (audited, before/after) -> force-logout (WS session.revoked) -> audit trail has both', async ({ request }) => {
  const admin = await test.step('admin TOTP login (register + promote + real enrollment flow)', () => createAdminSession(API_ORIGIN, ADMIN_EMAIL, 'journey-c-admin'));
  const target = await test.step('target user registers, verifies, logs in', () => registerAndLogin(API_ORIGIN, TARGET_EMAIL, 'journey-c-target'));

  let ticket = '';
  await test.step("target opens a WS ticket for its own live connection", async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/ws/ticket`, { headers: bearer(target.accessToken) });
    expect(res.status(), await res.text()).toBe(200);
    ({ ticket } = (await res.json()) as { ticket: string });
  });

  const socket = new WebSocket(wsUrl(ticket));
  const seenMessages: string[] = [];
  const revokedEvent = new Promise<{ type: string; sessionId: string; reason: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for session.revoked over WS (messages seen: ${JSON.stringify(seenMessages)}, readyState: ${socket.readyState})`)),
      20_000,
    );
    socket.on('message', (raw) => {
      seenMessages.push(raw.toString());
      const event = JSON.parse(raw.toString()) as { type: string; sessionId: string; reason: string };
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
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  // Force-logout runs *before* suspend, deliberately: `revokeAllUserSessions`
  // (both routes call it) only WS-pushes for the sessions it actually finds
  // still active (`WHERE revoked_at IS NULL`) — revoking twice in a row
  // means the second call finds nothing left to revoke, so the WS push
  // it's supposed to trigger silently never fires (reproduced while
  // authoring this spec: chaining suspend-then-force-logout on the same
  // target left the WS side hanging with no error at all — 200 OK, zero
  // sessions revoked, zero pushes). Force-logout first means its own
  // `revokeAllUserSessions` call has a genuinely still-active session to
  // revoke and push for.
  await test.step('admin force-logs-out the target (still an active session) -> the live WS connection gets session.revoked', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/admin/users/${target.userId}/force-logout`, {
      headers: bearer(admin.accessToken),
      data: { reason: 'e2e journey (c): force-logout half' },
    });
    expect(res.status(), await res.text()).toBe(200);

    const event = await revokedEvent;
    expect(event.reason).toBe('admin_force_logout');
    expect(event.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    socket.close();
  });

  await test.step("the target's own (force-logged-out) session is now unusable — 401, not suspended yet", async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/users/me`, { headers: bearer(target.accessToken) });
    expect(res.status()).toBe(401);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
  });

  await test.step('admin suspends the target (audited with a real before/after diff)', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/admin/users/${target.userId}/suspend`, {
      headers: bearer(admin.accessToken),
      data: { reason: 'e2e journey (c): suspend half' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('suspended');
  });

  await test.step("the target's account is now suspended — 403, a more specific reason than the stale token alone", async () => {
    // `plugins/auth.ts`'s `resolveAuthUser` checks `user.status ===
    // 'suspended'` *before* the row_version-staleness check, so a suspended
    // account's already-stale token now gets the more specific `FORBIDDEN`
    // (403) instead of `AUTH_SESSION_REVOKED` (401) — confirmed against the
    // real route while authoring this spec.
    const res = await request.get(`${API_ORIGIN}/api/v1/users/me`, { headers: bearer(target.accessToken) });
    expect(res.status()).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'FORBIDDEN' });
  });

  await test.step('the audit log has both actions, each with the admin as actor and a request id', async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/admin/audit?entityId=${target.userId}&limit=50`, { headers: bearer(admin.accessToken) });
    expect(res.status(), await res.text()).toBe(200);
    const entries = (await res.json()) as Array<{ action: string; actorId: string | null; before: unknown; after: unknown; requestId: string | null }>;

    const suspended = entries.find((e) => e.action === 'user.suspended');
    expect(suspended, JSON.stringify(entries)).toBeTruthy();
    expect(suspended!.actorId).toBe(admin.userId);
    expect(suspended!.before).toMatchObject({ status: 'active' });
    expect(suspended!.after).toMatchObject({ status: 'suspended' });
    expect(suspended!.requestId).toBeTruthy();

    const forceLoggedOut = entries.find((e) => e.action === 'user.force_logout');
    expect(forceLoggedOut, JSON.stringify(entries)).toBeTruthy();
    expect(forceLoggedOut!.actorId).toBe(admin.userId);
    expect((forceLoggedOut!.after as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThanOrEqual(1);
  });
});
