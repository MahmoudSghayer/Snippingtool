// Integration tests: license generation (via trial start), GET /licenses/me,
// POST /licenses/validate (device-limit enforcement, revoked/expired
// rejection), POST /licenses/regenerate (revokes old, issues new), and the
// signed entitlement blob verifying against ENTITLEMENT_PUBLIC_KEY.

import { devices, licenses, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { fastHash } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';

import type { FastifyInstance } from 'fastify';

let ipCounter = 50;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 254}`;
}

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

describe('licenses module', () => {
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
    await reseedPlans(app.db);
  });

  async function registerVerifyLogin(email: string, ip: string, fingerprint: string) {
    const device = {
      fingerprint,
      name: 'Test Device',
      browser: 'chrome',
      os: 'linux',
      extensionVersion: '1.0.0',
    };
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device, acceptTerms: true },
    });
    expect(registerRes.statusCode).toBe(201);
    const mail = app.mailer.sentEmails.at(-1);
    const token = extractToken(mail!.html);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token },
    });
    expect(verifyRes.statusCode).toBe(200);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(loginRes.statusCode).toBe(200);
    return loginRes.json().accessToken as string;
  }

  async function startTrial(ip: string, accessToken: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {
      subscription: { plan: { deviceLimit: number } };
      license: { key: string; keyPrefix: string };
    };
  }

  it('GET /licenses/me shows only the prefix + status, never the full key', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'license-me@example.com',
      ip,
      'fp-licenseme-0000000001',
    );
    const { license } = await startTrial(ip, accessToken);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/licenses/me',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keyPrefix).toBe(license.keyPrefix);
    expect(body.status).toBe('active');
    expect(body).not.toHaveProperty('key');
    expect(JSON.stringify(body)).not.toContain(license.key);
  });

  it('POST /licenses/validate: happy path returns entitlements + a JWS that verifies against ENTITLEMENT_PUBLIC_KEY', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'validate-happy@example.com',
      ip,
      'fp-validatehappy-000001',
    );
    const { license } = await startTrial(ip, accessToken);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: 'fp-validatehappy-000001' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.entitlements.plan).toBe('trial');
    expect(body.entitlements.deviceLimit).toBe(1);
    expect(typeof body.entitlementJws).toBe('string');

    const publicKey = await importSPKI(app.config.ENTITLEMENT_PUBLIC_KEY!, 'EdDSA');
    const { payload } = await jwtVerify(body.entitlementJws, publicKey);
    expect(payload.sub).toBeTruthy();
    expect((payload as { snapshot?: { plan?: string } }).snapshot?.plan).toBe('trial');
  });

  it('POST /licenses/validate: normalises a messy key (lowercase, no dashes, look-alike chars)', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'validate-messy@example.com',
      ip,
      'fp-validatemessy-00001',
    );
    const { license } = await startTrial(ip, accessToken);

    const messy = license.key.toLowerCase().replace(/-/g, '').replace(/0/g, 'o');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: messy, device: { fingerprint: 'fp-validatemessy-00001' } },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /licenses/validate: rejects an unrecognised key', async () => {
    const ip = nextIp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: {
        licenseKey: 'SL-0000-0000-0000-0001',
        device: { fingerprint: 'fp-unknown-0000000000001' },
      },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('LICENSE_INVALID');
  });

  it('POST /licenses/validate: enforces the plan device limit (trial = 1 device)', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'devicelimit-license@example.com',
      ip,
      'fp-devlimit-0000000001',
    );
    const { license } = await startTrial(ip, accessToken);

    // First device (this is the fingerprint already used at login/trial
    // start, so validate re-recognises it rather than counting a new one).
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: 'fp-devlimit-0000000001' } },
    });
    expect(first.statusCode).toBe(200);

    // A genuinely new device fingerprint exceeds the trial's 1-device limit.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: 'fp-devlimit-second-0001' } },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('DEVICE_LIMIT_REACHED');
  });

  // The device-limit bypass: a revoked device used to come back without a
  // limit check, and only devices tied to this licence were counted.
  it('POST /licenses/validate: re-activating a revoked device respects the device limit', async () => {
    const ip = nextIp();
    const fpA = 'fp-bypass-a-0000000001';
    const accessToken = await registerVerifyLogin('bypass@example.com', ip, fpA);
    const { license } = await startTrial(ip, accessToken);
    const validate = (fingerprint: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/licenses/validate',
        remoteAddress: ip,
        payload: { licenseKey: license.key, device: { fingerprint } },
      });
    const user = await app.db.query.users.findFirst({
      where: eq(users.email, 'bypass@example.com'),
    });

    expect((await validate(fpA)).statusCode).toBe(200);
    // Revoke A (as the dashboard's DELETE /devices/:id does).
    await app.db.update(devices).set({ status: 'revoked' }).where(eq(devices.userId, user!.id));
    expect((await validate('fp-bypass-b-0000000001')).statusCode).toBe(200);

    const again = await validate(fpA);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('DEVICE_LIMIT_REACHED');
  });

  it("POST /licenses/validate: counts every active device of the user, not only this licence's", async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'count-all@example.com',
      ip,
      'fp-countall-login-00001',
    );
    const { license } = await startTrial(ip, accessToken);

    // The login already registered one device; the trial allows one.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: 'fp-countall-other-00001' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DEVICE_LIMIT_REACHED');
  });

  it('POST /licenses/validate: recognises the device the user logged in from (one row, not two)', async () => {
    const ip = nextIp();
    const fp = 'fp-samedevice-0000001';
    const accessToken = await registerVerifyLogin('same-device@example.com', ip, fp);
    const { license } = await startTrial(ip, accessToken);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: fp } },
    });
    expect(res.statusCode).toBe(200);

    const user = await app.db.query.users.findFirst({
      where: eq(users.email, 'same-device@example.com'),
    });
    const rows = await app.db.query.devices.findMany({ where: eq(devices.userId, user!.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fingerprintHash).toBe(fp);
    expect(rows[0]!.licenseId).toBeTruthy();
  });

  // Rows the licence path wrote before it stored fingerprints the way login
  // does held fastHash(fingerprint). They are recognised and rewritten.
  it('POST /licenses/validate: adopts a legacy hashed-fingerprint row instead of adding a device', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'legacy-fp@example.com',
      ip,
      'fp-legacy-login-000001',
    );
    const { license } = await startTrial(ip, accessToken);
    const user = await app.db.query.users.findFirst({
      where: eq(users.email, 'legacy-fp@example.com'),
    });
    // Free the trial's single slot, then plant a legacy licence-path row.
    await app.db.update(devices).set({ status: 'revoked' }).where(eq(devices.userId, user!.id));
    const legacyFp = 'fp-legacy-ext-00000001';
    const legacyId = newId();
    await app.db.insert(devices).values({
      id: legacyId,
      userId: user!.id,
      fingerprintHash: fastHash(legacyFp),
      status: 'active',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: license.key, device: { fingerprint: legacyFp } },
    });
    expect(res.statusCode).toBe(200);
    const row = await app.db.query.devices.findFirst({ where: eq(devices.id, legacyId) });
    expect(row!.fingerprintHash).toBe(legacyFp);
    expect(row!.status).toBe('active');
  });

  it('login adopts a legacy hashed-fingerprint row instead of adding a device', async () => {
    const ip = nextIp();
    const email = 'legacy-login@example.com';
    const accessToken = await registerVerifyLogin(email, ip, 'fp-legacylogin-first01');
    await startTrial(ip, accessToken);
    const user = await app.db.query.users.findFirst({ where: eq(users.email, email) });
    await app.db.update(devices).set({ status: 'revoked' }).where(eq(devices.userId, user!.id));
    const legacyFp = 'fp-legacylogin-ext0001';
    const legacyId = newId();
    await app.db.insert(devices).values({
      id: legacyId,
      userId: user!.id,
      fingerprintHash: fastHash(legacyFp),
      status: 'active',
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device: { fingerprint: legacyFp } },
    });
    expect(login.statusCode).toBe(200);
    const active = await app.db.query.devices.findMany({
      where: and(eq(devices.userId, user!.id), eq(devices.status, 'active')),
    });
    expect(active.map((d) => d.id)).toEqual([legacyId]);
    expect(active[0]!.fingerprintHash).toBe(legacyFp);
  });

  it('POST /licenses/regenerate revokes the old key and issues a new one that validates; the old key is rejected', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'regenerate@example.com',
      ip,
      'fp-regenerate-00000001',
    );
    const { license: oldLicense } = await startTrial(ip, accessToken);

    const regenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/regenerate',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(regenRes.statusCode).toBe(200);
    const newLicense = regenRes.json();
    expect(newLicense.licenseKey).not.toBe(oldLicense.key);

    const oldRow = await app.db.query.licenses.findFirst({
      where: eq(licenses.keyPrefix, oldLicense.keyPrefix),
    });
    expect(oldRow!.status).toBe('revoked');
    expect(oldRow!.revokedReason).toBe('regenerated_by_user');

    const oldValidate = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: { licenseKey: oldLicense.key, device: { fingerprint: 'fp-regenerate-00000001' } },
    });
    expect(oldValidate.statusCode).toBe(402);
    expect(oldValidate.json().code).toBe('LICENSE_REVOKED');

    const newValidate = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/validate',
      remoteAddress: ip,
      payload: {
        licenseKey: newLicense.licenseKey,
        device: { fingerprint: 'fp-regenerate-00000001' },
      },
    });
    expect(newValidate.statusCode).toBe(200);
  });
});
