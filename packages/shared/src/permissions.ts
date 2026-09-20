/**
 * Admin role/permission matrix. `apps/api`'s `requirePermission('users.ban')`
 * decorator (docs/01-architecture.md, PHASE 4) imports this directly so the
 * matrix is defined exactly once and the dashboard can render the same
 * "you can't do that" state the API will enforce.
 */

export const ADMIN_ROLES = ['super_admin', 'support', 'analyst', 'billing'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export const PERMISSIONS = [
  'users.read',
  'users.write',
  'users.suspend',
  'users.ban',
  'users.force_logout',
  'users.reset_password',
  'subscriptions.read',
  'subscriptions.write',
  'coupons.write',
  'plans.write',
  'audit.read',
  'analytics.read',
  'system.read',
  'system.write',
  'feature_toggles.write',
  'config.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * `super_admin` gets everything. The other three roles are deliberately
 * narrow: `support` can act on a single user's account but never touch money
 * or config; `analyst` is read-only everywhere including audit, for
 * reporting without write risk; `billing` owns the money-shaped surface
 * (subscriptions, coupons, plans) plus enough user read access to look up an
 * account, but cannot suspend/ban or force logout.
 */
export const PERMISSION_MATRIX: Readonly<Record<AdminRole, readonly Permission[]>> = {
  super_admin: [...PERMISSIONS],
  support: [
    'users.read',
    'users.write',
    'users.suspend',
    'users.force_logout',
    'users.reset_password',
    'subscriptions.read',
    'audit.read',
  ],
  analyst: ['users.read', 'subscriptions.read', 'audit.read', 'analytics.read', 'system.read'],
  billing: [
    'users.read',
    'subscriptions.read',
    'subscriptions.write',
    'coupons.write',
    'plans.write',
    'audit.read',
  ],
};

export function permissionsForRole(role: AdminRole): readonly Permission[] {
  return PERMISSION_MATRIX[role];
}

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[role].includes(permission);
}

/** True only when every requested permission is granted to the role. */
export function hasAllPermissions(role: AdminRole, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/** True when at least one requested permission is granted to the role. */
export function hasAnyPermission(role: AdminRole, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}
