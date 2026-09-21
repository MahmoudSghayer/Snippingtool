// Resolves a user's admin grant (`admin_users.admin_role`) into the
// `adminRole`/`permissions` pair `userDtoSchema` carries (docs/07-dashboard.md
// §11 gap #1, docs/09-security.md). Used by `GET /users/me` (the caller's
// own grant) — see that schema's doc comment for why other `userDtoSchema`
// producers (e.g. admin user listings) don't call this per row.

import { adminUsers } from '@sl/db';
import { isAdminRole, permissionsForRole, type AdminRole, type Permission } from '@sl/shared';
import { eq } from 'drizzle-orm';

import type { Database } from '@sl/db';

export interface AdminSessionInfo {
  adminRole: AdminRole | null;
  permissions: Permission[];
}

export const NO_ADMIN_SESSION: AdminSessionInfo = { adminRole: null, permissions: [] };

export async function resolveAdminSession(db: Database, userId: string, role: string): Promise<AdminSessionInfo> {
  if (role !== 'admin') return NO_ADMIN_SESSION;
  const row = await db.query.adminUsers.findFirst({ where: eq(adminUsers.userId, userId) });
  if (!row || row.deletedAt || !isAdminRole(row.adminRole)) return NO_ADMIN_SESSION;
  return { adminRole: row.adminRole, permissions: [...permissionsForRole(row.adminRole)] };
}
