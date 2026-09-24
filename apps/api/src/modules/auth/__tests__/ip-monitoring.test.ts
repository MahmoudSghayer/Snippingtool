// IP monitoring (docs/09-security.md "IP monitoring"): ip_activity upsert
// on login + new-country / impossible-travel flag creation. Uses the
// `static` GeoIpProvider (lib/geoip.ts) to make country enrichment
// deterministic without a real geo database or network access.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { resetGeoIpProviderCacheForTests } from '../../../lib/geoip.js';

import type { FastifyInstance } from 'fastify';

const IP_US = '203.0.113.10';
const IP_DE = '198.51.100.20';

function device(fingerprint: string) {
  return {
    fingerprint,
    name: 'Test Device',
    browser: 'chrome',
    os: 'linux',
    extensionVersion: '1.0.0',
  };
}

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

/** The IP-monitoring write is best-effort and fired without awaiting from
 * `completeLogin` (service.ts), so it lands some time *after* the login
 * response. A fixed sleep raced it — 50ms was enough on a warm laptop and
 * not under CI's coverage instrumentation. Poll for the condition instead
 * (bounded), so the assertion is about *what* landed, not *when*. */
async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!ready(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    last = await read();
  }
  return last;
}

describe('auth module — IP monitoring', () => {
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
    process.env.GEOIP_PROVIDER = 'static';
    process.env.GEOIP_STATIC_MAP = JSON.stringify({ [IP_US]: 'US', [IP_DE]: 'DE' });
    resetGeoIpProviderCacheForTests();
  });

  afterEach(() => {
    delete process.env.GEOIP_PROVIDER;
    delete process.env.GEOIP_STATIC_MAP;
    resetGeoIpProviderCacheForTests();
  });

  async function registerVerifyAndLogin(email: string, ip: string, fp: string) {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device: device(fp), acceptTerms: true },
    });
    expect(registerRes.statusCode).toBe(201);
    const { userId } = registerRes.json();

    const token = extractToken(app.mailer.sentEmails.at(-1)!.html);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device: device(fp) },
    });
    expect(loginRes.statusCode).toBe(200);
    return userId as string;
  }

  it('upserts ip_activity with geo enrichment on login', async () => {
    const userId = await registerVerifyAndLogin(
      'geo1@example.com',
      IP_US,
      'fp-geo-1-0000000000000000',
    );

    // Best-effort background write (service.ts fires it without awaiting) —
    // wait for it to land before asserting.
    const rows = await waitFor(
      () => app.db.query.ipActivity.findMany({ where: (t, { eq }) => eq(t.userId, userId) }),
      (r) => r.length > 0,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip).toBe(IP_US);
    expect(rows[0]?.country).toBe('US');
    expect(rows[0]?.requestCount).toBe(1);
  });

  it('increments request_count on a repeat login from the same IP, without re-flagging', async () => {
    const email = 'geo2@example.com';
    const userId = await registerVerifyAndLogin(email, IP_US, 'fp-geo-2-0000000000000000');
    await waitFor(
      () => app.db.query.ipActivity.findMany({ where: (t, { eq }) => eq(t.userId, userId) }),
      (r) => r.length > 0,
    );

    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: IP_US,
      payload: {
        email,
        password: 'correcthorsebattery12',
        device: device('fp-geo-2-0000000000000000'),
      },
    });
    expect(secondLogin.statusCode).toBe(200);

    const rows = await waitFor(
      () => app.db.query.ipActivity.findMany({ where: (t, { eq }) => eq(t.userId, userId) }),
      (r) => r[0]?.requestCount === 2,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestCount).toBe(2);

    const flags = await app.db.query.flags.findMany({ where: (t, { eq }) => eq(t.userId, userId) });
    expect(flags).toHaveLength(0);
  });

  it('raises a suspicious_ip flag on login from a new country shortly after another (impossible travel)', async () => {
    // Same device fingerprint both times (the trial plan's device limit is
    // 1) — the scenario is one device's session token used from two
    // network locations shortly apart, not two different devices.
    const email = 'geo3@example.com';
    const sharedFingerprint = 'fp-geo-3-00000000000000000';
    const userId = await registerVerifyAndLogin(email, IP_US, sharedFingerprint);
    // The first login's (US) row is what the second login is compared
    // against — it must have landed before the DE login runs.
    await waitFor(
      () => app.db.query.ipActivity.findMany({ where: (t, { eq }) => eq(t.userId, userId) }),
      (r) => r.length > 0,
    );

    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: IP_DE,
      payload: { email, password: 'correcthorsebattery12', device: device(sharedFingerprint) },
    });
    expect(secondLogin.statusCode).toBe(200);

    const flags = await waitFor(
      () => app.db.query.flags.findMany({ where: (t, { eq }) => eq(t.userId, userId) }),
      (f) => f.length > 0,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]?.kind).toBe('suspicious_ip');
    expect(flags[0]?.severity).toBe('high');
    expect(flags[0]?.evidence).toMatchObject({
      reason: 'impossible_travel',
      newCountry: 'DE',
      previousCountry: 'US',
    });

    // `flagged` is set right after the flag row, in the same background
    // chain — poll for it the same way.
    const flaggedRow = await waitFor(
      () =>
        app.db.query.ipActivity.findFirst({
          where: (t, { and: andOp, eq }) => andOp(eq(t.userId, userId), eq(t.ip, IP_DE)),
        }),
      (row) => row?.flagged === true,
    );
    expect(flaggedRow?.flagged).toBe(true);
  });

  it('does not flag a brand-new user with no prior IP history', async () => {
    const userId = await registerVerifyAndLogin(
      'geo4@example.com',
      IP_DE,
      'fp-geo-4-0000000000000000',
    );
    await new Promise((r) => setTimeout(r, 50));

    const flags = await app.db.query.flags.findMany({ where: (t, { eq }) => eq(t.userId, userId) });
    expect(flags).toHaveLength(0);
  });
});
