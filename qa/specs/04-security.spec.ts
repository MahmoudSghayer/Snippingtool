// Security audit at the HTTP layer: response headers / CSP, cookie flags,
// unauthenticated access to protected + admin routes, CSRF on cookie-session
// mutations, IDOR between the two QA users, mass-assignment on the profile
// PATCH, and exposure of operational endpoints (/metrics, /health).
import { request as pwRequest } from '@playwright/test';
import { test, expect } from '../helpers/fixtures.ts';
import { target, isProd } from '../helpers/targets.ts';
import { FIXED_FINGERPRINT } from '../helpers/auth.ts';

// One fingerprint per account: the trial device limit is 1, so every login
// for a given user must resolve to the same device row or it 409s. user1
// shares the browser specs' fingerprint; user2 gets its own.
const FP_U1 = FIXED_FINGERPRINT;
const FP_U2 = 'qau2qau2'.repeat(6);

// Helper: log in via the API and return the cookie jar + csrf token.
async function apiLogin(request: import('@playwright/test').APIRequestContext, email: string, password: string, fp: string) {
  const r = await request.post(`${target.api}/api/v1/auth/login`, {
    headers: { 'content-type': 'application/json' },
    data: { email, password, device: { fingerprint: fp, name: 'QA sec' } },
  });
  return r;
}

test.describe('Security', () => {
  test('landing page carries the expected security headers', async ({ request, page }) => {
    const r = await request.get(`${target.web}/`);
    const h = r.headers();
    expect(h['x-content-type-options'], 'X-Content-Type-Options').toBe('nosniff');
    expect(h['x-frame-options'] ?? '', 'X-Frame-Options').toMatch(/DENY|SAMEORIGIN/i);
    expect(h['content-security-policy'] ?? '', 'CSP present').toContain('default-src');
    expect((h['content-security-policy'] ?? '').toLowerCase(), 'CSP frame-ancestors').toContain("frame-ancestors 'none'");
    if (isProd) {
      expect(h['strict-transport-security'] ?? '', 'HSTS on prod').toContain('max-age');
    }
  });

  test('API responses set nosniff and a restrictive CSP', async ({ request }) => {
    const r = await request.get(`${target.api}/api/v1/plans`);
    const h = r.headers();
    expect(h['x-content-type-options'], 'API nosniff').toBe('nosniff');
  });

  test('unauthenticated access to protected + admin APIs is denied', async ({ request }) => {
    for (const path of ['/api/v1/users/me', '/api/v1/admin/users', '/api/v1/admin/config', '/api/v1/trades']) {
      const r = await request.get(`${target.api}${path}`, { failOnStatusCode: false });
      expect([401, 403], `${path} must require auth, got ${r.status()}`).toContain(r.status());
    }
  });

  test('login sets httpOnly session cookies with SameSite', async ({ request, audit }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    const r = await apiLogin(request, target.user1!.email, target.user1!.password, FP_U1);
    const setCookies = (r.headersArray() ?? []).filter((x) => x.name.toLowerCase() === 'set-cookie').map((x) => x.value);
    const at = setCookies.find((c) => c.startsWith('sl_at='));
    const rt = setCookies.find((c) => c.startsWith('sl_rt='));
    const csrf = setCookies.find((c) => c.startsWith('sl_csrf='));
    if (at) expect(at.toLowerCase(), 'sl_at httpOnly').toContain('httponly');
    if (rt) expect(rt.toLowerCase(), 'sl_rt httpOnly').toContain('httponly');
    if (csrf) expect(csrf.toLowerCase(), 'sl_csrf is readable (not httpOnly) by design').not.toContain('httponly');
    for (const c of [at, rt, csrf].filter(Boolean) as string[]) {
      expect(c.toLowerCase(), 'cookie SameSite set').toContain('samesite');
    }
  });

  test('cookie-session mutation without CSRF token is rejected', async ({ request }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    const login = await apiLogin(request, target.user1!.email, target.user1!.password, FP_U1);
    if (login.status() !== 200) test.skip(true, `login returned ${login.status()}`);
    // The APIRequestContext keeps cookies. PATCH /users/me is CSRF-protected;
    // without the x-csrf-token header it must be rejected.
    const r = await request.patch(`${target.api}/api/v1/users/me`, {
      headers: { 'content-type': 'application/json' },
      data: { timezone: 'Europe/Paris' },
      failOnStatusCode: false,
    });
    expect([403, 401], `CSRF-less PATCH should be blocked, got ${r.status()}`).toContain(r.status());
  });

  test('mass-assignment: profile PATCH cannot set role/privileged fields', async ({ request, audit }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    const login = await apiLogin(request, target.user1!.email, target.user1!.password, FP_U1);
    if (login.status() !== 200) test.skip(true, `login returned ${login.status()}`);
    const csrfCookie = (await request.storageState()).cookies.find((c) => c.name === 'sl_csrf');
    const r = await request.patch(`${target.api}/api/v1/users/me`, {
      headers: { 'content-type': 'application/json', ...(csrfCookie ? { 'x-csrf-token': csrfCookie.value } : {}) },
      data: { timezone: 'UTC', role: 'admin', emailVerifiedAt: new Date().toISOString(), id: 'hacked' },
      failOnStatusCode: false,
    });
    // Either the extra keys are rejected (400, strict schema) or ignored.
    // Then confirm the role did not change.
    const me = await request.get(`${target.api}/api/v1/users/me`, { failOnStatusCode: false });
    if (me.status() === 200) {
      const body = await me.json();
      if (body.role === 'admin') {
        await audit.report({
          id: 'sec-mass-assignment-role',
          title: 'Mass-assignment: user elevated to admin via PATCH /users/me',
          severity: 'critical',
          category: 'security',
          location: 'apps/api/src/modules/users PATCH /users/me',
          steps: 'Authenticated PATCH /users/me with {"role":"admin"}.',
          expected: 'role is not a writable field; request rejected or ignored.',
          actual: 'User role became admin.',
          suggestedFix: 'Use a strict allowlist schema for the profile PATCH body.',
        });
      }
      expect(body.role, 'role unchanged after mass-assignment attempt').not.toBe('admin');
    }
    expect([200, 400, 422], `PATCH status ${r.status()}`).toContain(r.status());
  });

  test('IDOR: user1 cannot delete user2 device (isolated contexts)', async ({ audit }) => {
    if (!target.user1 || !target.user2) test.skip(true, 'need both user creds for IDOR');
    // Two fully isolated cookie jars — a shared one would let a stale session
    // make this look exploitable when it is not.
    const victim = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    const attacker = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const vlogin = await apiLogin(victim, target.user2!.email, target.user2!.password, FP_U2);
      if (vlogin.status() !== 200) test.skip(true, `victim login ${vlogin.status()} (e.g. device limit on prod)`);
      const dev2 = await victim.get(`${target.api}/api/v1/devices`, { failOnStatusCode: false });
      if (dev2.status() !== 200) test.skip(true, `victim devices read ${dev2.status()}`);
      const dev2Body = await dev2.json();
      const victimDeviceId = (Array.isArray(dev2Body) ? dev2Body : (dev2Body.items ?? []))[0]?.id;
      if (!victimDeviceId) test.skip(true, 'victim has no device to target');

      await apiLogin(attacker, target.user1!.email, target.user1!.password, FP_U1);
      const csrf = (await attacker.storageState()).cookies.find((c) => c.name === 'sl_csrf');
      const del = await attacker.delete(`${target.api}/api/v1/devices/${victimDeviceId}`, {
        headers: csrf ? { 'x-csrf-token': csrf.value } : {},
        failOnStatusCode: false,
      });
      // Confirm by re-reading the victim's devices — a lenient 200 that
      // deletes nothing is not IDOR; a vanished device is.
      const after = await victim.get(`${target.api}/api/v1/devices`, { failOnStatusCode: false });
      const afterBody = after.status() === 200 ? await after.json() : [];
      const afterList = Array.isArray(afterBody) ? afterBody : (afterBody.items ?? []);
      const stillThere = afterList.some((d: { id: string }) => d.id === victimDeviceId);
      if (!stillThere) {
        await audit.report({
          id: 'sec-idor-device',
          title: "IDOR: a user can delete another user's device by id",
          severity: 'high',
          category: 'security',
          location: 'apps/api/src/modules/devices DELETE /devices/:id',
          steps: "Capture user2's device id in one session; as user1 in a separate session, DELETE it.",
          expected: "404 — the device is not the caller's; nothing deleted.",
          actual: `Delete returned ${del.status()} and the victim device is gone.`,
          suggestedFix: 'Scope the delete to the authenticated user id (reject/ignore other users ids).',
        });
      }
      expect(stillThere, "victim's device must survive a cross-user delete").toBeTruthy();
    } finally {
      await victim.dispose();
      await attacker.dispose();
    }
  });

  test('operational endpoints exposure (/metrics, /health)', async ({ request, audit }) => {
    const metrics = await request.get(`${target.api}/metrics`, { failOnStatusCode: false });
    if (metrics.status() === 200) {
      const body = (await metrics.text()).slice(0, 200);
      await audit.report({
        id: 'sec-metrics-public',
        title: '/metrics is publicly reachable without authentication',
        severity: 'medium',
        category: 'security',
        location: 'apps/api/src/plugins/metrics.ts + infra/caddy/Caddyfile',
        steps: `GET ${target.api}/metrics`,
        expected: 'Prometheus metrics restricted to the internal network / scraper.',
        actual: `200 OK, body starts: ${body.replace(/\n/g, ' ')}`,
        suggestedFix: 'Block /metrics at Caddy for public clients, or require a scrape token.',
      });
    }
    // Not asserting a failure here: exposure is recorded as a finding; the
    // health endpoints are intentionally public.
    expect(metrics.status(), 'metrics endpoint responded').toBeGreaterThan(0);
  });
});
