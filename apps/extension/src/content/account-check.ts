/*
 * account-check.ts — what the running Nova AI bot's periodic entitlement
 * check (content/index.ts) makes of background's answers. Chrome-free, so it
 * is testable.
 *
 * Three different situations used to read the same — "no entitlement twice
 * in a row: your plan no longer includes Nova AI" — and an admin, whose plan
 * has every feature, was told exactly that when their session ended:
 *
 *   - background bootstrapped (or had a fresh, verified cache): the server's
 *     own word on the plan. Only this can mean `not_entitled`.
 *   - no entitlement, and the extension is signed out (no tokens left: a
 *     refresh was refused — session revoked, password changed, token reuse —
 *     or the user signed out): `signed_out`, at once. Fail closed.
 *   - no entitlement while still signed in (the API unreachable with no
 *     offline grace left, the service worker restarting, a refusal that is
 *     not about the session): carry on at first; only `missesBeforeStop`
 *     checks in a row make it `unreachable`.
 */
import type { BackgroundAnswer } from './background-request.js';
import type { BootstrapResponse } from '@sl/shared';

/** The part of background's `auth.status` answer (background/auth.ts
 * `AuthStatus`) this needs. */
export interface AccountStatus {
  hasAccount: boolean;
  signedOutReason?: string;
}

export type AccountCheck =
  /** The server's answer on the plan (its features decide). */
  | { kind: 'entitled'; bootstrap: BootstrapResponse }
  /** The session ended: stop now, with this message. */
  | { kind: 'signed_out'; detail: string }
  /** Not confirmed this time: carry on, the next check decides. */
  | { kind: 'unconfirmed'; misses: number }
  /** Not confirmed for `missesBeforeStop` checks in a row: stop. */
  | { kind: 'unreachable' };

export const ACCOUNT_MISSES_BEFORE_STOP = 2;

/** The bot's stop message for a sign-out, saying why when it is known. */
export function signedOutMessage(reason: string | undefined): string {
  return reason === 'password_changed'
    ? 'signed out of Nova Trade because the password changed — sign in again to restart'
    : 'signed out of Nova Trade — sign in again to restart';
}

export function createAccountCheck(deps: {
  bootstrap: () => Promise<BootstrapResponse | null>;
  authStatus: () => Promise<BackgroundAnswer<AccountStatus | null>>;
  missesBeforeStop?: number;
}): () => Promise<AccountCheck> {
  const missesBeforeStop = Math.max(1, deps.missesBeforeStop ?? ACCOUNT_MISSES_BEFORE_STOP);
  let misses = 0;
  return async () => {
    const bootstrap = await deps.bootstrap();
    if (bootstrap) {
      misses = 0;
      return { kind: 'entitled', bootstrap };
    }
    const status = await deps.authStatus();
    if (status.ok && status.data && !status.data.hasAccount) {
      misses = 0;
      return { kind: 'signed_out', detail: signedOutMessage(status.data.signedOutReason) };
    }
    misses += 1;
    if (misses < missesBeforeStop) return { kind: 'unconfirmed', misses };
    misses = 0;
    return { kind: 'unreachable' };
  };
}
