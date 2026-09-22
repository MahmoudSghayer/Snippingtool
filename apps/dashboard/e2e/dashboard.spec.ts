import { expect, test } from '@playwright/test';

import { loginAsAdmin } from './helpers/adminAuth.js';

/**
 * Runs against the real apps/api on the seeded dev database (Playwright's
 * `webServer` config starts both; global-setup.ts resets the seeded admin's
 * TOTP state and devices once for the whole run).
 *
 * One continuous journey in a single browser context (the seeded admin's
 * plan-less device limit is 1 — see global-setup.ts — so every step below
 * deliberately reuses the same `page`/device fingerprint rather than
 * spreading across contexts, which would each register a competing device):
 * login -> TOTP bootstrap-or-verify (`helpers/adminAuth.ts` — whichever this
 * spec file's turn in the run needs, since TOTP enrollment across the whole
 * suite happens at most once; `playwright.config.ts`'s `workers: 1` keeps
 * every spec file's admin login strictly serialised) -> admin overview
 * loads -> users search -> edit a profile -> the edit shows up in the audit
 * log.
 */
test('admin: login, TOTP bootstrap-or-verify, overview, user search, edit, audit trail', async ({
  page,
}) => {
  await test.step('login (2FA bootstrap or step-up verify)', async () => {
    await loginAsAdmin(page);
  });

  await test.step('admin overview loads', async () => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Online users')).toBeVisible();
  });

  const newTimezone = `Etc/e2e-${Date.now()}`.slice(0, 30);

  await test.step('search users and edit a profile', async () => {
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

    await page.getByPlaceholder('Email contains…').fill('dev@sniperledger.local');
    const row = page.getByRole('row', { name: /dev@sniperledger\.local/ });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    const timezoneInput = page.getByLabel('Timezone');
    await expect(timezoneInput).toBeVisible();
    await timezoneInput.fill(newTimezone);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Profile updated')).toBeVisible({ timeout: 10_000 });
  });

  await test.step('the edit appears in the audit log', async () => {
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await page.getByPlaceholder('user, subscription…').fill('user');
    const entry = page.getByText('user.updated').first();
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();
    await expect(page.getByText(newTimezone)).toBeVisible({ timeout: 10_000 });
  });
});
