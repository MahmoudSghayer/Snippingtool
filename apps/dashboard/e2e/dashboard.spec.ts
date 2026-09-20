import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';

import { SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_PASSWORD } from './global-setup.js';

/**
 * Runs against the real apps/api on the seeded dev database (Playwright's
 * `webServer` config starts both; global-setup.ts resets the seeded admin's
 * TOTP state and devices first so this always exercises the enrollment path
 * — see that file's header comment).
 *
 * One continuous journey in a single browser context (the seeded admin's
 * plan-less device limit is 1 — see global-setup.ts — so every step below
 * deliberately reuses the same `page`/device fingerprint rather than
 * spreading across contexts, which would each register a competing device):
 * login -> TOTP bootstrap (otplib generates the code from the secret the
 * enrollment screen displays) -> admin overview loads -> users search ->
 * edit a profile -> the edit shows up in the audit log.
 */
test('admin: login, TOTP bootstrap, overview, user search, edit, audit trail', async ({ page }) => {
  await test.step('login and bootstrap 2FA', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(SEEDED_ADMIN_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(SEEDED_ADMIN_PASSWORD);
    await page.getByLabel('This device').fill('Playwright e2e runner');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible({ timeout: 15_000 });

    const secret = (await page.getByTestId('copy-field-value').innerText()).trim();
    expect(secret.length).toBeGreaterThan(0);

    await page.getByLabel('Enter the 6-digit code to confirm').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
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
