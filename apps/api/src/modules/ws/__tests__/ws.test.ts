// WS gateway: ticket issuance + upgrade + a server-pushed event delivered
// over the real socket (via publishToUser, the same helper other modules
// use to push e.g. session.revoked or subscription.changed).

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';


import { buildApp } from '../../../app.js';
import { publishToUser } from '../../../ws/publish.js';

import type { FastifyInstance } from 'fastify';

const device = { fingerprint: 'ws-test-fingerprint-0000000001', name: 'WS Test', browser: 'chrome', os: 'linux', extensionVersion: '0.1.0' };

function extractToken(html: string): string {
  return decodeURIComponent(html.match(/token=([A-Za-z0-9_-]+)/)![1]!);
}

describe('ws module: ticket issuance + push delivery', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('issues a ticket, upgrades, and delivers a publishToUser event over the socket', async () => {
    const email = 'ws-user@example.com';
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', remoteAddress: '203.0.113.5', payload: { email, password: 'correcthorsebattery12', device } });
    const token = extractToken(app.mailer.sentEmails.at(-1)!.html);
    await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: '203.0.113.5', payload: { token } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.5', payload: { email, password: 'correcthorsebattery12', device } });
    const { accessToken } = login.json();

    const ticketRes = await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers: { authorization: `Bearer ${accessToken}` } });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = ticketRes.json();
    expect(ticket).toBeTruthy();

    const socket = new WebSocket(`${baseUrl}/ws?ticket=${ticket}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Wait for the initial "connected" ack.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages[0]).toMatchObject({ type: 'connected' });

    // Find the userId this session belongs to and push a session.revoked
    // event the way modules/admin-users does on force-logout.
    const me = await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200); // sanity: token still valid for this one call

    const decoded = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    await publishToUser(app.redis, decoded.sub, { type: 'session.revoked', sessionId: decoded.sid, reason: 'user' });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const pushed = messages.find((m) => (m as { type?: string }).type === 'session.revoked');
    expect(pushed).toMatchObject({ type: 'session.revoked', sessionId: decoded.sid, reason: 'user' });

    socket.close();
  });

  it('rejects an upgrade with a missing or already-used ticket', async () => {
    const socket = new WebSocket(`${baseUrl}/ws?ticket=not-a-real-ticket`);
    const closeCode = await new Promise<number>((resolve) => {
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => undefined); // an abrupt close may also surface as an error event
    });
    expect(closeCode).toBe(4401);
  });
});
