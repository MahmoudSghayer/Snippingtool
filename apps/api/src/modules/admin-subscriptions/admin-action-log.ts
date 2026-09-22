// Shared helper for every admin-* module this agent owns
// (admin-subscriptions/admin-licenses/admin-payments/admin-coupons/
// admin-plans/admin-bans/admin-flags): resolves the acting admin's
// `admin_users.id` (the FK `admin_actions.admin_user_id` needs — distinct
// from `users.id`, which is what `request.authUser.id` and
// `recordAudit`'s `actor.id` use instead) and writes one `admin_actions`
// row. Lives here (rather than duplicated per module) since every admin
// module in this agent's ownership can import a relative path into
// `admin-subscriptions/` without crossing into another agent's modules or
// triggering a second route registration (autoload only ever registers a
// folder's `index.ts`).

import { adminActions, adminUsers, type Database } from '@sl/db';
import { eq } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

/** Looks up the `admin_users` row for a logged-in admin's `users.id`. Throws
 * `FORBIDDEN` (should be unreachable in practice — `requirePermission` has
 * already confirmed the caller holds an admin permission, which itself reads
 * this same row — but a route handler must not assume the row still exists
 * a moment later without re-checking). */
export async function requireAdminUsersRowId(db: Database, userId: string): Promise<string> {
  const row = await db.query.adminUsers.findFirst({ where: eq(adminUsers.userId, userId) });
  if (!row || row.deletedAt) throw AppErrors.forbidden('Admin profile not found.');
  return row.id;
}

export interface RecordAdminActionOptions {
  db: Database;
  /** `admin_users.id` — get it via `requireAdminUsersRowId` first. */
  adminUserRowId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/** Writes one `admin_actions` row (the lightweight admin-activity-feed log —
 * distinct from, and in addition to, `audit_logs`/`recordAudit`, per
 * `docs/02-database.md` §6.1/§6.9). */
export async function recordAdminAction(options: RecordAdminActionOptions): Promise<void> {
  const { db, adminUserRowId, action, targetType, targetId, reason, metadata } = options;
  await db.insert(adminActions).values({
    id: newId(),
    adminUserId: adminUserRowId,
    action,
    targetType,
    targetId: targetId ?? null,
    reason: reason ?? null,
    metadata: metadata ?? {},
  });
}

/** Converts a Drizzle row (or any plain object) into a JSON-plain snapshot
 * suitable for `recordAudit`'s `before`/`after` — `Date` columns become ISO
 * strings, everything else passes through unchanged. Shallow: none of this
 * agent's audited tables have a nested object column that itself holds a
 * `Date` (JSONB columns hold already-JSON-safe values). Callers must strip
 * any secret column (none of this agent's tables have one — `licenses`
 * stores only `key_hash`, never a raw key) before passing a row here. */
export function toAuditSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    snapshot[key] = value instanceof Date ? value.toISOString() : value;
  }
  return snapshot;
}
