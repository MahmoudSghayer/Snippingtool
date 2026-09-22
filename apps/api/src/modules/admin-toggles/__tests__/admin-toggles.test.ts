// PATCH /api/v1/admin/toggles/kill_switch: broadcasts `kill_switch` over WS
// to admin:overview AND to every currently-online user's own channel (via
// the presence set + publishToUser) — not just admins watching the overview
// screen. Two regular users connect real WS sockets (same ticket-issue +
// upgrade flow as modules/ws/__tests__/ws.test.ts) and both must receive
// the event.

import { adminUsers, featureToggles, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

const device = {
  fingerprint: 'toggles-test-fingerprint-00001',
  name: 'Toggles Test',
  browser: 'chrome',
  os: 'linux',
  extensionVersion: '0.1.0',
};

function extractToken(html: string): string {
  return decodeURIComponent(html.match(/token=([A-Za-z0-9_-]+)/)![1]!);
}

async function createAdmin(
  app: FastifyInstance,
  adminRole: 'super_admin' | 'support' | 'analyst' | 'billing',
  email: string,
) {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(),
  });
  await app.db.insert(adminUsers).values({ id: newId(), userId, adminRole, permissions: {} });

  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

describe('admin-toggles module: kill-switch fan-out to online users', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let ipCounter = 20;

  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter % 254}`;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
    // resetDatabase() truncates feature_toggles along with everything else
    // (see src/test/reseed-reference-data.ts's doc comment on the same
    // contract for `plans`) — this route requires the row to already exist
    // (404s otherwise), so seed just the one key this test needs.
    await app.db.insert(featureToggles).values({ id: newId(), key: 'kill_switch', enabled: false });
  });

  async function connectUser(
    email: string,
    ip: string,
  ): Promise<{ userId: string; socket: WebSocket; messages: unknown[] }> {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(registerRes.statusCode).toBe(201);
    const mail = app.mailer.sentEmails.at(-1);
    const verifyToken = extractToken(mail!.html);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token: verifyToken },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = loginRes.json();

    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ws/ticket',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = ticketRes.json();

    const socket = new WebSocket(`${baseUrl}/ws?ticket=${ticket}`);
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages[0]).toMatchObject({ type: 'connected' });

    const decoded = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    );
    return { userId: decoded.sub as string, socket, messages };
  }

  it('delivers kill_switch to two distinct connected user sockets when an admin flips the toggle on', async () => {
    const userA = await connectUser('kill-switch-user-a@example.com', nextIp());
    const userB = await connectUser('kill-switch-user-b@example.com', nextIp());
    const { token: adminToken } = await createAdmin(
      app,
      'super_admin',
      'kill-switch-admin@example.com',
    );

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/toggles/kill_switch',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().enabled).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const { messages } of [userA, userB]) {
      const pushed = messages.find((m) => (m as { type?: string }).type === 'kill_switch');
      expect(pushed).toMatchObject({ type: 'kill_switch', active: true });
    }

    const toggleRow = await app.db.query.featureToggles.findFirst({
      where: eq(featureToggles.key, 'kill_switch'),
    });
    expect(toggleRow!.enabled).toBe(true);

    userA.socket.close();
    userB.socket.close();
    // Give the sockets' 'close' handlers (modules/ws/index.ts's fire-and-
    // forget markOffline()) a moment to finish their Redis calls before
    // afterAll() disconnects app.redis — otherwise those in-flight calls
    // reject with "Connection is closed" as unhandled rejections once this
    // is the last (only) test in the file.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
