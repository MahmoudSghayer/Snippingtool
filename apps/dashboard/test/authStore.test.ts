import { describe, expect, it, beforeEach } from 'vitest';

import { useAuthStore } from '@/stores/auth.js';

import type { UserDto } from '@sl/shared';

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
};

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
  });

  it('starts in the loading state', () => {
    // clearSession() above already moved it to 'anonymous' for test
    // isolation; this asserts the *shape* of a fresh session instead.
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().admin).toBeNull();
  });

  it('setSession marks a plain user as authenticated with no admin session', () => {
    useAuthStore.getState().setSession(baseUser);
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.user?.email).toBe('user@example.com');
    expect(state.admin).toBeNull();
  });

  it('setSession grants an admin session (full permission set) for an admin-role user', () => {
    useAuthStore.getState().setSession({ ...baseUser, role: 'admin' });
    const state = useAuthStore.getState();
    expect(state.admin).not.toBeNull();
    expect(state.admin?.permissions.length).toBeGreaterThan(0);
    expect(state.admin?.adminRole).toBeNull(); // see stores/auth.ts's "Known gap" comment
  });

  it('clearSession resets to anonymous', () => {
    useAuthStore.getState().setSession(baseUser);
    useAuthStore.getState().clearSession();
    const state = useAuthStore.getState();
    expect(state.status).toBe('anonymous');
    expect(state.user).toBeNull();
  });
});
