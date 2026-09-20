// Runs once, before the router renders its first route
// (docs/07-dashboard.md "Auth/CSRF/WS handling": "session bootstrap via
// /users/me on load"). Cached as a module-level promise so React 19 Strict
// Mode's double-invoke and every route's `beforeLoad` share one request
// instead of firing GET /users/me twice.
import { api } from '@/api/client.js';
import { useAuthStore } from '@/stores/auth.js';

let bootstrapPromise: Promise<void> | null = null;

export function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const { data, error } = await api.GET('/api/v1/users/me');
      if (error || !data) {
        useAuthStore.getState().clearSession();
        return;
      }
      useAuthStore.getState().setSession(data);
    })();
  }
  return bootstrapPromise;
}

/** Called after a successful login/register/mfa-verify (which already has
 * the fresh session) so the next protected-route guard doesn't need a round
 * trip, and after logout so a stale bootstrap doesn't linger. */
export function resetBootstrap(): void {
  bootstrapPromise = null;
}
