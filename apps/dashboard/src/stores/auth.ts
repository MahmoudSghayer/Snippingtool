// Session state. Bootstrapped from GET /users/me on load (docs/07-dashboard.md
// "Auth/CSRF/WS handling") and kept in a Zustand store rather than only in
// TanStack Query cache, because a handful of non-component modules
// (api/client.ts's 401 handler, the WS hook) need synchronous read access to
// "am I logged in" / "what's my role" without a hook.
//
// `GET /users/me` now carries the caller's own resolved `adminRole` and
// `permissions` (PERMISSION_MATRIX, apps/api's modules/users/index.ts) — so
// this store reflects the real per-permission grant, not just
// `role === 'admin'`. Every admin nav item/route is gated on the relevant
// `Permission`(s) (`usePermission`/`useAnyPermission`, src/lib/permissions.ts,
// src/lib/adminNav.ts); the server remains the actual enforcement point
// (`fastify.requirePermission`) and a call the caller's role doesn't grant
// still surfaces as an inline 403.
import { create } from 'zustand';

import type { AdminRole, Permission, UserDto } from '@sl/shared';

export interface AdminSessionInfo {
  adminRole: AdminRole | null;
  permissions: readonly Permission[];
}

interface AuthState {
  user: UserDto | null;
  admin: AdminSessionInfo | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  setSession: (user: UserDto) => void;
  clearSession: () => void;
  setLoading: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  admin: null,
  status: 'loading',
  setSession: (user) =>
    set({
      user,
      admin: user.role === 'admin' ? { adminRole: user.adminRole, permissions: user.permissions } : null,
      status: 'authenticated',
    }),
  clearSession: () => set({ user: null, admin: null, status: 'anonymous' }),
  setLoading: () => set({ status: 'loading' }),
}));
