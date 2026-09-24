// The one sign-out flow, shared by the website header (routes/SiteLayout.tsx)
// and the admin sidebar (routes/layouts.tsx). Anything that must happen on
// every sign-out belongs in `logout()`, not in either caller.
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { api } from '@/api/client.js';
import { resetBootstrap } from '@/lib/authBootstrap.js';
import { useAuthStore } from '@/stores/auth.js';

/** Ends the server session, then forgets it locally. The local part runs
 * even when the request fails (offline, already expired): the user asked to
 * be signed out of this browser either way. */
export async function logout(): Promise<void> {
  try {
    await api.POST('/api/v1/auth/logout', { body: { allDevices: false } });
  } catch {
    // Network failure: still sign out locally below.
  }
  resetBootstrap();
  useAuthStore.getState().clearSession();
}

/** `logout()` followed by the sign-in page, for a button's onClick. */
export function useLogout(): () => Promise<void> {
  const navigate = useNavigate();
  return useCallback(async () => {
    await logout();
    await navigate({ to: '/login' });
  }, [navigate]);
}
