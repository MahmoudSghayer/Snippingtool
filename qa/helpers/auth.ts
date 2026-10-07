// Login helpers for the audit specs. Mirrors the real dashboard flow:
// email + password + device name, then the TOTP step (admin) or none (user).
// A fixed device fingerprint is pinned so repeated logins resolve to one
// device row rather than tripping the plan device limit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authenticator } from 'otplib';
import type { Page } from '@playwright/test';

import type { Creds } from './targets.ts';

export const FIXED_FINGERPRINT = 'qa000000'.repeat(6);

// Persist the TOTP secret captured during first-login enrolment so later spec
// files in the same run (which see the verify screen, not enrolment) can
// generate codes for the same admin. Mirrors apps/dashboard/e2e/helpers.
const SECRET_FILE = path.join(os.tmpdir(), 'nova-qa-admin-totp.txt');

function readStoredSecret(): string | undefined {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

export async function pinFingerprint(page: Page): Promise<void> {
  await page.addInitScript((fp) => {
    try {
      window.localStorage.setItem('sl_dashboard_device_fingerprint', fp);
    } catch {
      /* storage blocked */
    }
  }, FIXED_FINGERPRINT);
}

/** Log in as a plain user. Returns false if the login did not reach /account. */
export async function loginUser(page: Page, creds: Creds, deviceName = 'QA audit'): Promise<boolean> {
  await pinFingerprint(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  const device = page.getByLabel('This device');
  if (await device.count()) await device.fill(deviceName);
  await page.getByRole('button', { name: 'Sign in' }).click();
  try {
    await page.waitForURL(/\/account/, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Log in as admin, completing TOTP enrolment or step-up verification. */
export async function loginAdmin(
  page: Page,
  creds: Creds & { totpSecret?: string },
  deviceName = 'QA audit admin',
): Promise<{ ok: boolean; secret?: string }> {
  await pinFingerprint(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  const device = page.getByLabel('This device');
  if (await device.count()) await device.fill(deviceName);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const enrollSecret = page.getByTestId('copy-field-value');
  const verifyCode = page.getByLabel('Verification code');
  try {
    await enrollSecret.or(verifyCode).first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    return { ok: false };
  }

  let secret = creds.totpSecret ?? readStoredSecret();
  if (await enrollSecret.isVisible().catch(() => false)) {
    secret = (await enrollSecret.innerText()).trim();
    try {
      fs.writeFileSync(SECRET_FILE, secret, 'utf8');
    } catch {
      /* best-effort */
    }
    await page.getByLabel('Enter the 6-digit code to confirm').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
  } else {
    if (!secret) return { ok: false };
    await verifyCode.fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  try {
    await page.waitForURL(/\/admin$/, { timeout: 15_000 });
    return { ok: true, secret };
  } catch {
    return { ok: false, secret };
  }
}
