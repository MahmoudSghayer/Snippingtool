// What "you are no longer this user, on this tab" means, shared by every
// path that ends a session client-side: sign-out (lib/logout.ts, used by
// the site header and the admin sidebar), the WS gateway's `session.revoked`
// push (hooks/useWsGateway.ts), and account deletion
// (components/account/Security.tsx `DeleteAccountCard`).
//
// Defect C9 (this branch's P0 fix list): none of those three call
// sites cleared TanStack Query's cache, only the Zustand auth store. On a
// shared machine/browser profile, the next person to log in on the same tab
// could still see the previous user's cached dashboard/trades/admin queries
// until each one happened to refetch — a real data leak between accounts,
// not just a stale-UI glitch.
import { forgetCsrfToken } from '@/api/client.js';
import { useAuthStore } from '@/stores/auth.js';

import { resetBootstrap } from './authBootstrap.js';
import { queryClient } from './queryClient.js';

/** Clears every piece of client-side session state. Does not navigate —
 * callers decide where to send the user (or, for `session.revoked`, whether
 * a toast is owed first). */
export function clearLocalSession(): void {
  queryClient.clear();
  forgetCsrfToken();
  useAuthStore.getState().clearSession();
  resetBootstrap();
}
