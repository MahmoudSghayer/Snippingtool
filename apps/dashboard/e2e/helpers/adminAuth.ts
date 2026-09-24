// Shared admin login for every e2e spec (dashboard.spec.ts,
// accessibility.spec.ts, visual-smoke.spec.ts). global-setup.ts resets the
// seeded admin to a "never enrolled 2FA" state once per whole test run, so
// only the *first* spec file to log in sees the enrollment screen — every
// spec after that sees the plain verify-code screen instead, for the same
// admin, in the same run. This helper handles both paths transparently by
// persisting the TOTP secret to the OS temp dir on first enrollment and
// reading it back on every subsequent login within the same run (a fresh
// `os.tmpdir()`-backed file per run is exactly the right lifetime here:
// `playwright.config.ts` sets `workers: 1` so spec files never race each
// other for it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';
import { authenticator } from 'otplib';

import { SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_PASSWORD } from '../global-setup.js';

import type { Page } from '@playwright/test';

const SECRET_FILE = path.join(os.tmpdir(), 'sl-e2e-admin-totp-secret.txt');

// The dashboard generates and persists a random per-browser-profile device
// fingerprint in localStorage (src/lib/device.ts) — each spec *file* gets
// its own fresh, isolated Playwright context (and so its own random
// fingerprint) by default, which would register a *competing* device on
// every spec file's login. The seeded admin's plan-less device limit is 1
// (global-setup.ts), so that would 409 every login after the first. Forcing
// the same fixed fingerprint here makes every spec file's login resolve to
// the *same* device row (`unique(user_id, fingerprint_hash)` upserts it)
// instead, matching how one real QA machine would behave.
const FIXED_DEVICE_FINGERPRINT = 'e2e00000'.repeat(6); // 48 hex-ish chars, well within the 16–256 schema bound

/** Logs the given page in as the seeded admin, completing TOTP
 * enrollment (first spec of the run) or step-up verification (every spec
 * after), and waits for the admin dashboard (`/admin`), where an admin
 * lands after signing in. */
export async function loginAsAdmin(
  page: Page,
  deviceName = 'Playwright e2e runner',
): Promise<void> {
  await page.addInitScript((fingerprint) => {
    try {
      window.localStorage.setItem('sl_dashboard_device_fingerprint', fingerprint);
    } catch {
      // Storage blocked (shouldn't happen under Playwright/Chromium) — the
      // app falls back to a fresh random fingerprint per page load, which
      // is only a problem for the device-limit concern above, not for
      // login itself.
    }
  }, FIXED_DEVICE_FINGERPRINT);

  await page.goto('/login');
  await page.getByLabel('Email').fill(SEEDED_ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(SEEDED_ADMIN_PASSWORD);
  await page.getByLabel('This device').fill(deviceName);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Branch on the enrolment *secret*, not on the heading above it. The
  // heading is only a label; the secret is what this helper actually
  // consumes, so keying off it can never commit to a screen whose data has
  // not rendered. LoginPage.tsx no longer shows either heading while it is
  // still probing enroll-vs-verify (it used to show the enrolment one, which
  // made this branch pick the enrolment path and then wait out the whole
  // timeout on a secret that was never coming), and this keeps the suite from
  // re-acquiring that race should the page ever regress.
  const enrollSecret = page.getByTestId('copy-field-value');
  const verifyHeading = page.getByRole('heading', { name: 'Two-factor verification' });

  await expect(enrollSecret.or(verifyHeading)).toBeVisible({ timeout: 15_000 });

  if (await enrollSecret.isVisible().catch(() => false)) {
    // The heading and the secret must always render together.
    await expect(
      page.getByRole('heading', { name: 'Set up two-factor authentication' }),
    ).toBeVisible();
    const secret = (await enrollSecret.innerText()).trim();
    expect(secret.length).toBeGreaterThan(0);
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');

    await page.getByLabel('Enter the 6-digit code to confirm').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
  } else {
    const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    await page.getByLabel('Verification code').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }

  await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 });
}
