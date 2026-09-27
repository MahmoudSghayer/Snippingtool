import { Writable } from 'node:stream';

import { featureToggles } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { entitlementBlobClaimsSchema } from '@sl/shared';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';

import type { FastifyInstance } from 'fastify';

const device = {
  fingerprint: 'ext-test-fingerprint-000000001',
  name: 'Ext Test',
  browser: 'chrome',
  os: 'linux',
  extensionVersion: '0.1.0',
};

function extractToken(html: string): string {
  return decodeURIComponent(html.match(/token=([A-Za-z0-9_-]+)/)![1]!);
}

async function registerLoginVerified(app: FastifyInstance, email: string, ip: string) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: 'correcthorsebattery12', device, acceptTerms: true },
  });
  const token = extractToken(app.mailer.sentEmails.at(-1)!.html);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    remoteAddress: ip,
    payload: { token },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { email, password: 'correcthorsebattery12', device },
  });
  return login.json().accessToken as string;
}

describe('extension module: bootstrap/heartbeat + activity batch idempotency', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('bootstrap returns entitlements, settings, a signed blob, and killSwitchActive=false by default', async () => {
    const accessToken = await registerLoginVerified(app, 'bootstrap@example.com', '198.51.100.10');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBeTruthy();
    expect(body.deviceId).toBeTruthy();
    expect(body.entitlementBlob).toBeTruthy();
    expect(body.killSwitchActive).toBe(false);
    expect(body.settings.governor).toBeTruthy();
    expect(Array.isArray(body.features)).toBe(true);
    expect(body.email).toBe('bootstrap@example.com');
  });

  it("bootstrap returns only the caller's own email, never another user's", async () => {
    const tokenA = await registerLoginVerified(app, 'owner-a@example.com', '198.51.100.20');
    const tokenB = await registerLoginVerified(app, 'owner-b@example.com', '198.51.100.21');

    const boot = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/extension/bootstrap',
        headers: { authorization: `Bearer ${token}` },
        payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
      });
    const [a, b] = [await boot(tokenA), await boot(tokenB)];
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().email).toBe('owner-a@example.com');
    expect(b.json().email).toBe('owner-b@example.com');
    expect(a.body).not.toContain('owner-b@example.com');
    expect(b.body).not.toContain('owner-a@example.com');
  });

  it('heartbeat updates device last-seen/version and returns the same shape minus userId', async () => {
    const accessToken = await registerLoginVerified(app, 'heartbeat@example.com', '198.51.100.11');
    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
    });
    const { deviceId } = bootstrap.json();

    const hb = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId, extensionVersion: '0.2.0', engineState: 'running' },
    });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().deviceId).toBe(deviceId);
    expect(hb.json().userId).toBeUndefined();
    // Email is a bootstrap-only field: heartbeat neither looks it up nor returns it.
    expect(hb.json().email).toBeUndefined();
    expect(hb.body).not.toContain('heartbeat@example.com');
  });

  it('activity batch ingest is idempotent for a byte-identical retried event', async () => {
    const accessToken = await registerLoginVerified(app, 'activity@example.com', '198.51.100.12');

    const event = {
      type: 'search',
      occurredAt: new Date().toISOString(),
      metadata: { filterHash: 'abc123', resultsCount: 5, floorPrice: 1000 },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/batch',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { events: [event] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, deduped: 0 });

    // Same batch resent (e.g. client retried after a dropped response).
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/batch',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { events: [event] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: 0, deduped: 1 });
  });

  // The extension trusts a *cached* entitlement only through this blob
  // (apps/extension/src/lib/license.ts): features, expiry and the kill
  // switch are read from its verified claims, never from the unsigned
  // response fields it cached alongside. So the kill switch has to be
  // inside the signature, and has to match the live toggle.
  it('bootstrap and heartbeat sign the kill switch into the entitlement blob', async () => {
    const accessToken = await registerLoginVerified(app, 'blob-ks@example.com', '198.51.100.13');
    const publicKey = await importSPKI(app.config.ENTITLEMENT_PUBLIC_KEY!, 'EdDSA');

    const off = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
    });
    const offBody = off.json();
    expect(decodeProtectedHeader(offBody.entitlementBlob).alg).toBe('EdDSA');
    const { payload: offClaims } = await jwtVerify(offBody.entitlementBlob, publicKey);
    const parsedOff = entitlementBlobClaimsSchema.parse(offClaims);
    expect(parsedOff.killSwitchActive).toBe(false);
    expect(parsedOff.sub).toBe(offBody.userId);
    expect(parsedOff.deviceId).toBe(offBody.deviceId);
    expect(parsedOff.snapshot.features).toEqual(offBody.features);

    await app.db.insert(featureToggles).values({ id: newId(), key: 'kill_switch', enabled: true });

    const hb = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/heartbeat',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: offBody.deviceId, extensionVersion: '0.1.0', engineState: 'running' },
    });
    const hbBody = hb.json();
    expect(hbBody.killSwitchActive).toBe(true);
    const { payload: onClaims } = await jwtVerify(hbBody.entitlementBlob, publicKey);
    expect(entitlementBlobClaimsSchema.parse(onClaims).killSwitchActive).toBe(true);
  });

  it('GET /extension/version and /extension/kill-switch are unauthenticated and return sane defaults', async () => {
    const version = await app.inject({ method: 'GET', url: '/api/v1/extension/version' });
    expect(version.statusCode).toBe(200);
    expect(version.json().latestVersion).toBeTruthy();

    const killSwitch = await app.inject({ method: 'GET', url: '/api/v1/extension/kill-switch' });
    expect(killSwitch.statusCode).toBe(200);
    expect(killSwitch.json().active).toBe(false);
  });
});

// The email bootstrap returns must never reach a log line. This app logs at
// trace with NO redaction configured, so the test proves the email is never
// handed to the logger at all (not merely censored by the default config's
// `*.email` redact path).
describe('extension bootstrap: the email is never logged', () => {
  let app: FastifyInstance;
  const lines: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    app = await buildApp({ logger: { level: 'trace', stream } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('logs the bootstrap request without the email', async () => {
    const email = 'never-logged@example.com';
    const accessToken = await registerLoginVerified(app, email, '198.51.100.30');
    lines.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(email);

    const bootstrapLines = lines.filter((l) => l.includes('/api/v1/extension/bootstrap'));
    expect(bootstrapLines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(email);
  });
});
