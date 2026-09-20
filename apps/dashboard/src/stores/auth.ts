// Session state. Bootstrapped from GET /users/me on load (docs/07-dashboard.md
// "Auth/CSRF/WS handling") and kept in a Zustand store rather than only in
// TanStack Query cache, because a handful of non-component modules
// (api/client.ts's 401 handler, the WS hook) need synchronous read access to
// "am I logged in" / "what's my role" without a hook.
//
// KNOWN GAP (documented in docs/07-dashboard.md "Admin permission gating"
// and the handoff report): `userDtoSchema` (GET /users/me) does not carry
// the caller's own `admin_role`/permission set — only `role: 'user'|'admin'`
// — so this store cannot know *which* of the four admin roles the current
// admin is client-side. Every admin nav item and route is therefore gated on
// `role === 'admin'` only; the real per-permission enforcement
// (`PERMISSION_MATRIX`) happens server-side on every mutating call, and a
// call the caller's role doesn't grant surfaces as a 403 the page displays
// inline. `admin.permissions` below defaults to every permission so today's
// UI stays fully usable; the moment the API exposes the caller's real
// `adminRole` (e.g. on `GET /users/me` or a new `GET /admin/me`), swap the
// `PERMISSIONS` fallback below for the resolved value and every consumer of
// `usePermission`/`useAnyPermission` (src/lib/permissions.ts) starts
// reflecting it with no further change.
import { PERMISSIONS } from '@sl/shared';
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
      admin: user.role === 'admin' ? { adminRole: null, permissions: PERMISSIONS } : null,
      status: 'authenticated',
    }),
  clearSession: () => set({ user: null, admin: null, status: 'anonymous' }),
  setLoading: () => set({ status: 'loading' }),
}));
