// Integration tests: license generation (via trial start), GET /licenses/me,
// POST /licenses/validate (device-limit enforcement, revoked/expired
// rejection), POST /licenses/regenerate (revokes old, issues new), and the
// signed entitlement blob verifying against ENTITLEMENT_PUBLIC_KEY.

import { licenses } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
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
