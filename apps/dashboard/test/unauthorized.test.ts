import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDto } from '@sl/shared';

vi.mock('@/api/client.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
  forgetCsrfToken: vi.fn(),
}));

const { handleUnauthorized } = await import('@/lib/unauthorized.js');
const { queryClient } = await import('@/lib/queryClient.js');
const { useAuthStore } = await import('@/stores/auth.js');

const user: UserDto = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'user@example.com',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  role: 'user',
  totpEnabled: false,
  timezone: 'UTC',
  timezoneSetAt: null,
  referralCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  adminRole: null,
  permissions: [],
};

/** Review M5: an unrecoverable 401 (the session is gone and the silent
 * refresh could not bring it back) sent the browser to /login but left the
 * previous user's cached queries in memory for whoever signs in next. */
describe('handleUnauthorized', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/account');
    useAuthStore.getState().setSession(user);
    queryClient.setQueryData(['account'], { secret: 'previous user' });
  });

  afterEach(() => {
    queryClient.clear();
    useAuthStore.getState().clearSession();
  });

  it('clears the query cache and the session, then sends the browser to /login', () => {
    const navigate = vi.fn();
    handleUnauthorized('/account?tab=security', navigate);

    expect(queryClient.getQueryData(['account'])).toBeUndefined();
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(navigate).toHaveBeenCalledWith('/account?tab=security');
  });

  it('does not navigate again when already on /login', () => {
    window.history.replaceState(null, '', '/login');
    const navigate = vi.fn();
    handleUnauthorized('/login', navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['account'])).toBeUndefined();
  });
});
