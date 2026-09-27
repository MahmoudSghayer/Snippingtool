import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDto } from '@sl/shared';

const postMock = vi.hoisted(() => vi.fn());

// `logout` is unit-tested against a mocked `api` module rather than a
// mocked `fetch` (contrast test/apiClient.test.ts, which is exactly what
// exercises the real HTTP layer this mock stands in for) — this test's job
// is only "does logout clear local state before/regardless of what
// the network call does", which doesn't need a real Request/Response
// round-trip.
vi.mock('@/api/client.js', () => ({ api: { POST: postMock }, forgetCsrfToken: vi.fn() }));

const { logout } = await import('@/lib/logout.js');
const { queryClient } = await import('@/lib/queryClient.js');
const { useAuthStore } = await import('@/stores/auth.js');

const baseUser: UserDto = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'user@example.com',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  role: 'user',
  totpEnabled: false,
  timezone: 'UTC',
  referralCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  adminRole: null,
  permissions: [],
};

/** Defect C9 (this branch's P0 fix list): logout never called
 * `queryClient.clear()`, so the previous user's cached dashboard/trades/admin
 * queries survived in memory for whoever logged into the same tab next. */
describe('logout', () => {
  beforeEach(() => {
    postMock.mockReset();
    useAuthStore.getState().setSession(baseUser);
    queryClient.setQueryData(['trades'], [{ id: 'trade-1' }]);
  });

  afterEach(() => {
    queryClient.clear();
    useAuthStore.getState().clearSession();
  });

  it('calls POST /auth/logout, then clears the query cache and the auth store', async () => {
    postMock.mockResolvedValue({ data: { ok: true }, error: undefined });

    await logout();

    expect(postMock).toHaveBeenCalledWith('/api/v1/auth/logout', { body: { allDevices: false } });
    expect(queryClient.getQueryData(['trades'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('still clears the query cache and auth store when the logout request throws (network error)', async () => {
    postMock.mockRejectedValue(new Error('network down'));

    // Swallowed: the user asked to be signed out of this browser either way.
    await expect(logout()).resolves.toBeUndefined();

    expect(queryClient.getQueryData(['trades'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });
});
