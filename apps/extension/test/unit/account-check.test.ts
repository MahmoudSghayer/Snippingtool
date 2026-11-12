// The running Nova AI bot's entitlement check (content/account-check.ts,
// wired in content/index.ts). An admin's bot stopped with "your plan no
// longer includes Nova AI" when what had happened was a sign-out (a revoked
// session, a password change): two empty answers in a row read as a plan
// problem. Now only the server's own answer can say "not in your plan", a
// sign-out stops the bot at once and says so, and an account that merely
// cannot be confirmed stops nothing on the first miss.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACCOUNT_SIGNED_OUT_GRACE_CHECKS, createAccountCheck, signedOutMessage, type AccountStatus } from '../../src/content/account-check.js';

import type { BackgroundAnswer } from '../../src/content/background-request.js';
import type { BootstrapResponse } from '@sl/shared';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const contentSource = readFileSync(path.resolve(dirname, '../../src/content/index.ts'), 'utf8');

function boot(features: string[]): BootstrapResponse {
  return { features, killSwitchActive: false } as unknown as BootstrapResponse;
}

/** Background answering the bootstrap and `auth.status` from queues (the
 * last answer repeats). */
function background(bootstraps: (BootstrapResponse | null)[], statuses: BackgroundAnswer<AccountStatus | null>[]) {
  let b = 0;
  let s = 0;
  return {
    bootstrap: async () => bootstraps[Math.min(b++, bootstraps.length - 1)] ?? null,
    authStatus: async () => statuses[Math.min(s++, statuses.length - 1)]!,
  };
}

const SIGNED_IN: BackgroundAnswer<AccountStatus | null> = { ok: true, data: { hasAccount: true } };
const NO_ANSWER: BackgroundAnswer<AccountStatus | null> = { ok: false };

describe('content/account-check.ts', () => {
  it("passes the server's answer on, whatever its features: the plan is the server's to judge", async () => {
    const check = createAccountCheck(background([boot([])], [SIGNED_IN]));
    expect(await check()).toEqual({ kind: 'entitled', bootstrap: boot([]) });
  });

  it('a sign-out keeps the bot running a short grace, then stops — never as a plan problem', async () => {
    // Login dropped but still signed out each check: a grace (the bot keeps
    // running so an active bid finishes), then a stop once the grace is spent.
    const signedOut = { ok: true as const, data: { hasAccount: false, signedOutReason: 'session_ended' } };
    const check = createAccountCheck({ ...background([null], [signedOut]), signedOutGraceChecks: 2 });
    const detail = 'signed out of Nova Trade — sign in again to restart';
    expect(await check()).toEqual({ kind: 'signed_out_grace', detail });
    const stop = await check();
    expect(stop).toEqual({ kind: 'signed_out', detail });
    expect(JSON.stringify(stop)).not.toContain('plan');
  });

  it('uses a multi-check grace by default, not an instant stop', async () => {
    const check = createAccountCheck(background([null], [{ ok: true, data: { hasAccount: false } }]));
    expect((await check()).kind).toBe('signed_out_grace');
    expect(ACCOUNT_SIGNED_OUT_GRACE_CHECKS).toBeGreaterThan(1);
  });

  it('a login that comes back inside the grace resumes with no stop', async () => {
    const signedOut = { ok: true as const, data: { hasAccount: false } };
    const check = createAccountCheck({
      ...background([null, boot(['automation.autobuyer']), null], [signedOut]),
      signedOutGraceChecks: 2,
    });
    expect((await check()).kind).toBe('signed_out_grace'); // signed out: grace
    expect((await check()).kind).toBe('entitled'); // login back: resumes
    expect((await check()).kind).toBe('signed_out_grace'); // signed out again: grace afresh, not a stop
  });

  it('says when the password change is why', async () => {
    const check = createAccountCheck(background([null], [{ ok: true, data: { hasAccount: false, signedOutReason: 'password_changed' } }]));
    expect(await check()).toEqual({
      kind: 'signed_out_grace',
      detail: 'signed out of Nova Trade because the password changed — sign in again to restart',
    });
    expect(signedOutMessage(undefined)).toBe('signed out of Nova Trade — sign in again to restart');
  });

  it('an account that cannot be confirmed stops nothing on the first miss, and is unreachable on the second in a row', async () => {
    const check = createAccountCheck(background([null], [SIGNED_IN]));
    expect(await check()).toEqual({ kind: 'unconfirmed', misses: 1 });
    expect(await check()).toEqual({ kind: 'unreachable' });
  });

  it('a service worker that does not answer is a miss, not a sign-out', async () => {
    const check = createAccountCheck(background([null], [NO_ANSWER]));
    expect((await check()).kind).toBe('unconfirmed');
    expect((await check()).kind).toBe('unreachable');
  });

  it('a confirmed answer in between starts the count again', async () => {
    const check = createAccountCheck(background([null, boot(['automation.autobuyer']), null, null], [SIGNED_IN]));
    expect((await check()).kind).toBe('unconfirmed');
    expect((await check()).kind).toBe('entitled');
    expect((await check()).kind).toBe('unconfirmed');
    expect((await check()).kind).toBe('unreachable');
  });
});

describe('content/index.ts: the bot’s stop reasons', () => {
  const check = /const checkAccount = createAccountCheck\([\s\S]*?\}, ENTITLEMENT_CHECK_MS\);/.exec(contentSource)?.[0] ?? '';

  it('asks background for the bootstrap and the auth status', () => {
    expect(check).toContain("bootstrap: () => send<BootstrapResponse>('license.bootstrap'),");
    expect(check).toContain("authStatus: () => bg.request<AccountStatus | null>('auth.status'),");
  });

  it('stops as not entitled only on an answer from the server that lacks automation', () => {
    const entitled = /if \(check\.kind === 'entitled'\) \{([\s\S]*?)\n {8}\}/.exec(check)?.[1] ?? '';
    expect(entitled).toContain("if (!features.includes('automation.autobuyer')) stopAutomation('not_entitled'");
    expect(check.match(/'not_entitled'/g)).toHaveLength(2); // the type, and that one call
    expect(check).toContain("if (check.kind === 'unconfirmed') return;");
  });

  it('keeps the bot running through a short sign-out grace instead of stopping at once', () => {
    expect(check).toContain("if (check.kind === 'signed_out_grace') {");
    // the grace branch keeps the bot running: it returns without stopping.
    const grace = /if \(check\.kind === 'signed_out_grace'\) \{([\s\S]*?)\n {8}\}/.exec(check)?.[1] ?? '';
    expect(grace).not.toContain('stopAutomation');
    expect(grace).toContain('return;');
  });

  it('hands the account issue to the bot, which checks it ahead of the plan', () => {
    expect(contentSource).toContain('account: () => accountIssue,');
  });
});
