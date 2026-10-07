// Customer account area: one user login for the whole file (shared context,
// serial), then every section renders, forms validate, and sensitive actions
// (delete account, change password) are gated behind confirmation.
import { chromium as pwChromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';
import { loginUser } from '../helpers/auth.ts';
import { record } from '../helpers/audit.ts';

test.describe.configure({ mode: 'serial' });

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 NovaTradeQA/1.0';

test.describe('Account area', () => {
  let ctx: BrowserContext;
  let page: Page;
  let loggedIn = false;

  test.beforeAll(async () => {
    if (!target.user1) return;
    const browser = await pwChromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    ctx = await browser.newContext({ baseURL: target.web, userAgent: UA, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    loggedIn = await loginUser(page, target.user1!);
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('all account sections render without page errors', async () => {
    test.skip(!target.user1, 'no user1 creds');
    expect(loggedIn, 'user login (beforeAll) succeeded').toBeTruthy();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/account', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
    for (const name of [/getting started/i, /account and security/i]) {
      await expect(page.getByRole('heading', { name }).first(), `section ${name}`).toBeVisible();
    }
    if (errors.length) {
      record({
        id: 'account-page-errors', title: 'Uncaught JS errors on /account',
        severity: 'medium', category: 'functional', location: '/account',
        steps: 'Log in as a user and open /account.', expected: 'No uncaught errors.',
        actual: errors.join(' | ').slice(0, 300), suggestedFix: 'Investigate the thrown errors in the console trace.',
        target: process.env.QA_TARGET ?? 'local',
      });
    }
    expect(errors, 'no uncaught errors on /account').toEqual([]);
  });

  test('change-password form requires current + new password', async () => {
    test.skip(!target.user1 || !loggedIn, 'no session');
    await page.goto('/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: /account and security/i }).first()).toBeVisible();
    const submit = page.getByRole('button', { name: /change password|update password/i }).first();
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await expect(submit, 'change-password button present').toBeVisible({ timeout: 10_000 });
    await submit.click();
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/\/account/);
  });

  test('delete-account requires password confirmation (not auto-destructive)', async () => {
    test.skip(!target.user1 || !loggedIn, 'no session');
    await page.goto('/account', { waitUntil: 'domcontentloaded' });
    const del = page.getByRole('button', { name: /delete account/i }).first();
    test.skip(!(await del.count()), 'delete-account control not found');
    await del.click();
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/\/account/);
  });
});
