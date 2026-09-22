import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLES,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  PERMISSIONS,
} from '../src/permissions.js';

describe('hasPermission', () => {
  it('grants super_admin every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission('super_admin', permission)).toBe(true);
    }
  });

  it('never grants analyst a write permission', () => {
    const writePermissions = PERMISSIONS.filter((p) => p.endsWith('.write'));
    for (const permission of writePermissions) {
      expect(hasPermission('analyst', permission)).toBe(false);
    }
  });

  it('lets support act on a user account but not on billing', () => {
    expect(hasPermission('support', 'users.suspend')).toBe(true);
    expect(hasPermission('support', 'users.ban')).toBe(false);
    expect(hasPermission('support', 'coupons.write')).toBe(false);
  });

  it('lets billing manage subscriptions/coupons/plans but not ban users', () => {
    expect(hasPermission('billing', 'subscriptions.write')).toBe(true);
    expect(hasPermission('billing', 'coupons.write')).toBe(true);
    expect(hasPermission('billing', 'users.ban')).toBe(false);
    expect(hasPermission('billing', 'users.force_logout')).toBe(false);
  });

  it('covers every declared admin role', () => {
    expect(ADMIN_ROLES).toEqual(['super_admin', 'support', 'analyst', 'billing']);
  });
});

describe('hasAllPermissions / hasAnyPermission', () => {
  it('hasAllPermissions requires every permission to be granted', () => {
    expect(hasAllPermissions('billing', ['subscriptions.write', 'coupons.write'])).toBe(true);
    expect(hasAllPermissions('billing', ['subscriptions.write', 'users.ban'])).toBe(false);
  });

  it('hasAnyPermission requires only one', () => {
    expect(hasAnyPermission('analyst', ['users.write', 'users.read'])).toBe(true);
    expect(hasAnyPermission('analyst', ['users.write', 'users.ban'])).toBe(false);
  });
});
