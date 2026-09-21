// Open-redirect guard (docs/09-security.md "Open redirect"): every
// caller-supplied redirect target the payments module accepts
// (`successUrl`/`cancelUrl` on checkout, `returnUrl` on the billing portal)
// must start with the configured `DASHBOARD_ORIGIN` — see
// `assertDashboardOrigin` in apps/api/src/modules/payments/index.ts. Without
// it, a forged request could hand back an attacker-controlled URL for the
// dashboard's own JS to `window.location`-redirect the victim's browser to
// (e.g. a phishing page that then reuses the still-valid session cookie's
// CSRF token, or simply steals credentials on a look-alike page).
//
// `assertDashboardOrigin` runs before any Stripe/DB work, so these requests
// 400 on the origin check alone — no Stripe test keys or seeded plan/price
// data are needed for this suite.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, type TestApp } from './helpers.js';

describe('open redirect: payments redirect targets must stay on DASHBOARD_ORIGIN', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('POST /payments/checkout rejects an off-origin successUrl', async () => {
    const user = await createUserSession(app, 'redirect-checkout@example.com', 'redirect-fp-checkout-00000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/checkout',
      headers: bearer(user.accessToken),
      payload: {
        planCode: 'basic',
        successUrl: 'https://evil.example.com/steal',
        cancelUrl: `${app.config.DASHBOARD_ORIGIN}/billing/cancelled`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('POST /payments/checkout rejects an off-origin cancelUrl even when successUrl is legitimate', async () => {
    const user = await createUserSession(app, 'redirect-checkout-2@example.com', 'redirect-fp-checkout2-0000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/checkout',
      headers: bearer(user.accessToken),
      payload: {
        planCode: 'basic',
        successUrl: `${app.config.DASHBOARD_ORIGIN}/billing/success`,
        cancelUrl: 'https://evil.example.com/steal',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('rejects a successUrl that merely starts with a similar-looking string but is a different origin (e.g. DASHBOARD_ORIGIN as a subdomain suffix trick)', async () => {
    const user = await createUserSession(app, 'redirect-checkout-3@example.com', 'redirect-fp-checkout3-0000001');
    const evilLookalike = `https://evil-${new URL(app.config.DASHBOARD_ORIGIN as string).host}.attacker.example`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/checkout',
      headers: bearer(user.accessToken),
      payload: { planCode: 'basic', successUrl: evilLookalike, cancelUrl: evilLookalike },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /payments/portal rejects an off-origin returnUrl', async () => {
    const user = await createUserSession(app, 'redirect-portal@example.com', 'redirect-fp-portal-000000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/portal',
      headers: bearer(user.accessToken),
      payload: { returnUrl: 'https://evil.example.com/steal' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('these routes require CSRF/auth before ever reaching the origin check (unauthenticated -> 401, not 400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/checkout',
      payload: { planCode: 'basic', successUrl: 'https://evil.example.com', cancelUrl: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(401);
  });
});
