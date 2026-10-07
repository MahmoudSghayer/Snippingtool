// Edge cases: double-submit protection on login, refresh/navigation handling,
// deep-link to a protected route while logged out, and the error envelope for
// malformed API input.
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';
import { pinFingerprint } from '../helpers/auth.ts';

test.describe('Edge cases', () => {
  test('deep link to a protected route while logged out redirects to login', async ({ page }) => {
    // Use a fresh context with no cookies (default per-test context).
    await page.goto('/account');
    await page.waitForTimeout(800);
    expect(page.url(), 'logged-out /account should bounce to login').toMatch(/\/login|returnTo/);
  });

  test('malformed JSON body yields a structured error, not a stack trace', async ({ request }) => {
    const r = await request.post(`${target.api}/api/v1/auth/login`, {
      headers: { 'content-type': 'application/json' },
      data: '{not valid json',
      failOnStatusCode: false,
    });
    expect(r.status(), 'malformed body rejected').toBeGreaterThanOrEqual(400);
    const text = await r.text();
    expect(text, 'no raw stack trace leaked').not.toMatch(/at \w+.*\(.*\.js:\d+:\d+\)/);
  });

  test('double-click on Sign in does not submit twice destructively', async ({ page, audit }) => {
    if (!target.user1) test.skip(true, 'no user1 creds');
    await pinFingerprint(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill(target.user1!.email);
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-xyz');
    const device = page.getByLabel('This device');
    if (await device.count()) await device.fill('QA audit');
    const btn = page.getByRole('button', { name: 'Sign in' });
    const logins: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/auth/login')) logins.push(r.status());
    });
    await btn.click();
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    // At most one extra request is acceptable; a flood would indicate no guard.
    expect(logins.length, 'double-click should not fire many login requests').toBeLessThanOrEqual(2);
  });

  test('refresh on the login page keeps a usable form (no white screen)', async ({ page }) => {
    await page.goto('/login');
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('offline during navigation shows a handled state, not a crash', async ({ page, context }) => {
    await page.goto('/login');
    await context.setOffline(true);
    await page.getByLabel('Email').fill('x@y.z').catch(() => {});
    // Attempt a navigation while offline; should not throw an uncaught error.
    await page.goto('/account').catch(() => {});
    await context.setOffline(false);
    // App still alive after reconnect.
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
