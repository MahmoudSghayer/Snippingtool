// Which `Permission`(s) each admin page needs — mirrors docs/07-dashboard.md
// §2's routes/permissions matrix. A page is reachable (nav item shown, route
// not 404ing) when the caller's `admin.permissions` includes *any* one of
// its entry's permissions; used by routes/layouts.tsx (nav filtering) and
// router.tsx (route-level `beforeLoad` guards) so both stay in lock-step
// with the one table below instead of drifting.
import type { Permission } from '@sl/shared';

export const ADMIN_NAV_PERMISSIONS = {
  'admin-overview': ['analytics.read'],
  'admin-users': ['users.read'],
  'admin-profits': ['analytics.read'],
  'admin-activity': ['analytics.read'],
  'admin-system': ['system.read'],
  'admin-audit': ['audit.read'],
  // The page shows both plan-mix analytics and (deliverable 2) the live
  // subscriptions list/lookup — reachable to either an analyst
  // (analytics.read) or billing (subscriptions.read) admin.
  'admin-subscriptions': ['subscriptions.read', 'analytics.read'],
  'admin-coupons': ['coupons.write'],
  'admin-plans': ['plans.write'],
  'admin-flags': ['users.suspend', 'users.ban'],
  'admin-bans': ['users.suspend', 'users.ban'],
  'admin-toggles': ['feature_toggles.write'],
  'admin-config': ['system.read', 'config.write'],
} as const satisfies Record<string, readonly Permission[]>;

export type AdminNavKey = keyof typeof ADMIN_NAV_PERMISSIONS;

export function permissionsFor(key: AdminNavKey): readonly Permission[] {
  return ADMIN_NAV_PERMISSIONS[key];
}
