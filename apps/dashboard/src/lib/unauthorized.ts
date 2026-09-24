// What an unrecoverable 401 does (api/client.ts calls the handler that
// router.tsx registers with this): the session is gone and the silent refresh
// could not bring it back, so forget it locally — query cache included
// (clearLocalSession, defect C9), or the previous user's cached data would
// outlive them on this tab — and send the browser to /login with a way back.
import { clearLocalSession } from '@/lib/session.js';
import { useAuthStore } from '@/stores/auth.js';

/** `navigate(returnTo)` goes to /login?returnTo=… (router.tsx supplies it).
 * Clears only a session that was signed in: a signed-out visitor's 401 has
 * nothing to clear, and resetting the bootstrap on every such 401 would make
 * each guard re-fetch /users/me. */
export function handleUnauthorized(path: string, navigate: (returnTo: string) => void): void {
  if (useAuthStore.getState().status === 'authenticated') clearLocalSession();
  if (window.location.pathname === '/login') return;
  navigate(path);
}
