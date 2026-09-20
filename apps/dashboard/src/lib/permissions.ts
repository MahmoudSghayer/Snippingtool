import { useAuthStore } from '@/stores/auth.js';

import type { Permission } from '@sl/shared';

/** Reactive permission check for use inside components (hides nav items /
 * route guards per PHASE 7's "nav items hidden without permission and routes
 * guarded" requirement). The API is the actual enforcement point — this only
 * controls what the UI offers, matching docs/04-auth.md's own framing. */
export function usePermission(permission: Permission): boolean {
  return useAuthStore((s) => !!s.admin?.permissions.includes(permission));
}

export function useAnyPermission(permissions: Permission[]): boolean {
  return useAuthStore((s) => permissions.some((p) => s.admin?.permissions.includes(p)));
}
