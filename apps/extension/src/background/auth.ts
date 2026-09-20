/*
 * background/auth.ts — handlers for `auth.login`/`auth.logout`/
 * `auth.refresh`/`auth.status`. Thin over `lib/auth.ts`; the service worker's
 * job here is just message routing (rule 5: no loops, no extra state beyond
 * what `lib/auth.ts` already keeps in `storage.session`/`storage.local`).
 */
import type { LoginResponse, MfaVerifyRequest, RegisterRequest } from '@sl/shared';

import { computeFingerprint, detectBrowser, detectOs } from '../lib/fingerprint.js';
import * as auth from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { runBootstrap } from './license.js';

export interface AuthStatus {
  authenticated: boolean;
}

const EXTENSION_VERSION = import.meta.env.VITE_EXTENSION_VERSION;

/** The popup only ever sends `{ email, password }` — the device fingerprint
 * is computed here, not in the popup, so every caller of `auth.login`
 * builds it the same way (`lib/license.ts` does the same for bootstrap). */
async function buildDevice() {
  return { fingerprint: await computeFingerprint(), browser: detectBrowser(), os: detectOs(), extensionVersion: EXTENSION_VERSION };
}

export async function handleAuthLogin(payload: { email: string; password: string }): Promise<LoginResponse> {
  const result = await auth.login({ email: payload.email, password: payload.password, device: await buildDevice() });
  if (result.status === 'ok') {
    // Bootstrap right after a successful login (docs/01-architecture.md,
    // §3.1's final step) so entitlements/settings are ready before the
    // content script asks for them.
    runBootstrap().catch((err) => logger.warn(`post-login bootstrap failed: ${String(err)}`, 'auth'));
  }
  return result;
}

export async function handleAuthRegister(payload: {
  email: string;
  password: string;
  timezone?: string;
  referralCode?: string;
}): Promise<LoginResponse> {
  const body: RegisterRequest = { ...payload, device: await buildDevice() };
  const result = await auth.register(body);
  if (result.status === 'ok') {
    runBootstrap().catch((err) => logger.warn(`post-register bootstrap failed: ${String(err)}`, 'auth'));
  }
  return result;
}

export async function handleAuthMfaVerify(payload: MfaVerifyRequest): Promise<LoginResponse> {
  const result = await auth.verifyMfa(payload);
  if (result.status === 'ok') {
    runBootstrap().catch((err) => logger.warn(`post-mfa bootstrap failed: ${String(err)}`, 'auth'));
  }
  return result;
}

export async function handleAuthLogout(payload: { allDevices?: boolean } = {}): Promise<void> {
  await auth.logout(payload.allDevices ?? false);
}

export async function handleAuthStatus(): Promise<AuthStatus> {
  return { authenticated: await auth.isAuthenticated() };
}
