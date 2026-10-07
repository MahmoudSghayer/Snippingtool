// Authentication audit: registration validation, login errors, TOTP,
// password reset entry, session behaviour, and the open-redirect check on
// the post-login `returnTo` handling.
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';
import { loginUser, loginAdmin, pinFingerprint } from '../helpers/auth.ts';

test.describe('Authentication', () => {
  test('login rejects wrong password with a clear error and no token', async ({ page, audit }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    await pinFingerprint(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill(target.user1!.email);
    await page.getByLabel('Password', { exact: true }).fill('wrong-password-123');
    const device = page.getByLabel('This device');
    if (await device.count()) await device.fill('QA audit');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/auth/login')).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    expect(resp?.status(), 'bad login should be 4xx').toBeGreaterThanOrEqual(400);
    await expect(page).toHaveURL(/\/login/);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'sl_at'), 'no access cookie on failed login').toBeUndefined();
  });

  test('registration form enforces its validation rules', async ({ page, audit }) => {
    await page.goto('/register');
    // Submitting empty should not navigate away / should surface errors.
    const submit = page.getByRole('button', { name: /create account|register|sign up/i }).first();
    if (await submit.count()) {
      await submit.click();
      await page.waitForTimeout(500);
      await expect(page, 'empty submit must stay on register').toHaveURL(/\/register/);
    }
    // Weak password (short) must be rejected client- or server-side.
    const email = page.getByLabel(/email/i);
    if (await email.count()) {
      await email.fill(`qa.reg.${Date.now()}@novatrade.local`);
      const pw = page.getByLabel('Password', { exact: true });
      if (await pw.count()) await pw.fill('short');
      const confirm = page.getByLabel(/confirm/i);
      if (await confirm.count()) await confirm.fill('short');
      const terms = page.getByRole('checkbox');
      if (await terms.count()) await terms.first().check().catch(() => {});
      if (await submit.count()) await submit.click();
      await page.waitForTimeout(600);
      expect(page.url(), 'weak password must not create an account').toContain('/register');
    }
  });

  test('user can sign in and reach /account', async ({ page }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    const ok = await loginUser(page, target.user1!);
    expect(ok, 'user1 login should reach /account').toBeTruthy();
  });

  test('admin sign-in requires TOTP and reaches /admin', async ({ page }) => {
    if (!target.admin) test.skip(true, 'no admin creds');
    const r = await loginAdmin(page, target.admin!);
    expect(r.ok, 'admin login should reach /admin after TOTP').toBeTruthy();
  });

  test('forgot-password never reveals whether an account exists', async ({ page, request }) => {
    const r1 = await request.post(`${target.api}/api/v1/auth/password/reset-request`, {
      data: { email: 'definitely-not-a-user@example.com' },
      headers: { 'content-type': 'application/json' },
    });
    const r2 = await request.post(`${target.api}/api/v1/auth/password/reset-request`, {
      data: { email: target.user1?.email ?? 'qa.user1@novatrade.local' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r1.status(), 'same status for unknown and known email').toBe(r2.status());
  });

  test('open-redirect: returnTo to an external host is not honoured', async ({ page, audit }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    await pinFingerprint(page);
    // Try a backslash-prefixed host, which some sanitisers miss.
    await page.goto('/login?returnTo=/\\evil.example.com');
    await page.getByLabel('Email').fill(target.user1!.email);
    await page.getByLabel('Password', { exact: true }).fill(target.user1!.password);
    const device = page.getByLabel('This device');
    if (await device.count()) await device.fill('QA audit');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(2500);
    const host = new URL(page.url()).host;
    const onTarget = host === new URL(target.web).host;
    if (!onTarget) {
      await audit.report({
        id: 'auth-open-redirect',
        title: 'Post-login returnTo allows navigation to an external host',
        severity: 'medium',
        category: 'security',
        location: 'apps/dashboard/src/routes/access.ts postLoginPath',
        steps: 'Open /login?returnTo=/\\evil.example.com and sign in.',
        expected: 'Redirect stays on the dashboard origin.',
        actual: `Landed on host ${host}.`,
        suggestedFix: 'Reject returnTo values that are not same-origin absolute paths, including backslash variants.',
      });
    }
    expect(onTarget, `post-login host should be the dashboard, got ${host}`).toBeTruthy();
  });
});
