import { devices, featureToggles, userActivity } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { entitlementBlobClaimsSchema } from '@sl/shared';
import { and, eq } from 'drizzle-orm';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';
import { grantPlan } from '../../../test/plan-fixtures.js';

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

  // A deviceId in the body is only a claim. Heartbeat signs an entitlement
  // blob for it, so it must be one of the caller's active devices; the
  // telemetry and error reports just don't attribute to a device that isn't.
  async function bootstrapFor(email: string, ip: string) {
    const accessToken = await registerLoginVerified(app, email, ip);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { device, extensionVersion: '0.1.0', buildTarget: 'ledger' },
    });
    const body = res.json();
    return { accessToken, userId: body.userId as string, deviceId: body.deviceId as string };
  }

  it("heartbeat refuses another user's device and a revoked device of the caller's", async () => {
    const mine = await bootstrapFor('hb-owner@example.com', '198.51.100.20');
    const theirs = await bootstrapFor('hb-other@example.com', '198.51.100.21');
    const heartbeat = (deviceId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/extension/heartbeat',
        headers: { authorization: `Bearer ${mine.accessToken}` },
        payload: { deviceId, extensionVersion: '0.2.0', engineState: 'running' },
      });

    const foreign = await heartbeat(theirs.deviceId);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('DEVICE_NOT_FOUND');

    await app.db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, mine.deviceId));
    const revoked = await heartbeat(mine.deviceId);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json().code).toBe('DEVICE_NOT_FOUND');
  });

  it("telemetry and error reports store deviceId = null for a device that isn't the caller's", async () => {
    const mine = await bootstrapFor('tel-owner@example.com', '198.51.100.22');
    const theirs = await bootstrapFor('tel-other@example.com', '198.51.100.23');
    await grantPlan(app, mine.userId, 'pro');

    const telemetry = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/telemetry',
      headers: { authorization: `Bearer ${mine.accessToken}` },
      payload: {
        deviceId: theirs.deviceId,
        events: [{ name: 'ping', occurredAt: new Date().toISOString() }],
      },
    });
    expect(telemetry.statusCode).toBe(200);

    const errors = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/errors',
      headers: { authorization: `Bearer ${mine.accessToken}` },
      payload: {
        deviceId: theirs.deviceId,
        extensionVersion: '0.1.0',
        errors: [{ message: 'boom', occurredAt: new Date().toISOString() }],
      },
    });
    expect(errors.statusCode).toBe(200);

    const rows = await app.db.query.userActivity.findMany({
      where: and(eq(userActivity.userId, mine.userId)),
    });
    const reported = rows.filter((r) => r.type === 'other' || r.type === 'error');
    expect(reported).toHaveLength(2);
    for (const row of reported) expect(row.deviceId).toBeNull();

    // The caller's own active device is still attributed.
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/errors',
      headers: { authorization: `Bearer ${mine.accessToken}` },
      payload: {
        deviceId: mine.deviceId,
        extensionVersion: '0.1.0',
        errors: [{ message: 'mine', occurredAt: new Date().toISOString() }],
      },
    });
    expect(own.statusCode).toBe(200);
    const after = await app.db.query.userActivity.findMany({
      where: and(eq(userActivity.userId, mine.userId), eq(userActivity.deviceId, mine.deviceId)),
    });
    expect(after.some((r) => r.type === 'error')).toBe(true);
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
