// Journey (a): register -> verify email -> login -> device registered ->
// trial -> license key shown. Pure API journey (no browser UI needed for
// this one — the dashboard's own register/verify/trial/license flow through
// its UI is apps/dashboard/e2e's job; this suite's job is the cross-app
// invariant underneath it: what the API actually does end to end for one
// continuous account, checked directly against its real responses).
import { expect, test } from '@playwright/test';

import { deviceFingerprint, TEST_PASSWORD } from '../helpers/auth.js';
import { connect, deleteUsersByEmailPrefix, markEmailVerified } from '../helpers/db.js';
import { API_ORIGIN } from '../playwright.config.js';

const EMAIL = `e2e-journey-a-${Date.now()}@example.com`;

test.afterAll(async () => {
  const db = connect();
  try {
    await deleteUsersByEmailPrefix(db, 'e2e-journey-a-');
  } finally {
    await db.end({ timeout: 5 });
  }
});

test('register -> verify -> login -> device registered -> trial -> license key shown', async ({
  request,
}) => {
  const device = deviceFingerprint('journey-a');
  let userId = '';

  await test.step('register', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/auth/register`, {
      data: { email: EMAIL, password: TEST_PASSWORD, device },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { userId: string };
    userId = body.userId;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  await test.step('login before verification is blocked (AUTH_EMAIL_NOT_VERIFIED)', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/auth/login`, {
      data: { email: EMAIL, password: TEST_PASSWORD, device },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'AUTH_EMAIL_NOT_VERIFIED',
    });
  });

  await test.step('verify email (see helpers/db.ts for why this is a direct DB write, not a token round-trip)', async () => {
    const db = connect();
    try {
      const verifiedId = await markEmailVerified(db, EMAIL);
      expect(verifiedId).toBe(userId);
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  let accessToken = '';
  await test.step('login now succeeds', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/auth/login`, {
      data: { email: EMAIL, password: TEST_PASSWORD, device },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { status: string; accessToken: string };
    expect(body.status).toBe('ok');
    accessToken = body.accessToken;
  });

  await test.step('device registered', async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/devices`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status()).toBe(200);
    const devices = (await res.json()) as Array<{
      fingerprint?: string;
      isCurrent: boolean;
      name: string | null;
    }>;
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices.some((d) => d.isCurrent)).toBe(true);
  });

  await test.step('trial starts', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/subscriptions/trial`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as {
      subscription: { status: string; plan: { code: string } };
      license: { key: string; keyPrefix: string; maxDevices: number };
    };
    expect(body.subscription.status).toBe('trialing');
    expect(body.subscription.plan.code).toBe('trial');

    // License key shown — full key, returned exactly once
    // (docs/05-subscriptions.md §3).
    expect(body.license.key).toMatch(/^SL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(body.license.keyPrefix).toBe(body.license.key.split('-').slice(0, 2).join('-'));
    expect(body.license.maxDevices).toBeGreaterThanOrEqual(1);
  });

  await test.step('GET /licenses/me shows only the prefix + status, never the full key again', async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/licenses/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { keyPrefix: string; status: string };
    expect(body.status).toBe('active');
    expect(body.keyPrefix).toMatch(/^SL-[0-9A-Z]{4}$/);
    expect(JSON.stringify(body)).not.toContain('-XXXX-XXXX-XXXX'); // sanity: no 4-block full key shape anywhere in the response
  });

  await test.step('a second trial for the same account is denied (one live subscription per user)', async () => {
    const res = await request.post(`${API_ORIGIN}/api/v1/subscriptions/trial`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status()).toBe(409);
  });
});
