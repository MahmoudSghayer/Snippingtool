// recordAudit(): the one function every mutating route (admin or not) calls
// to write an audit_logs row. Computes a shallow before/after diff so the
// dashboard's diff viewer never has to. audit_logs is append-only (DB-level
// REVOKE UPDATE/DELETE + trigger — see packages/db migrations/0020), so this
// only ever INSERTs.

import { auditLogs, type Database } from '@sl/db';

import { newId } from './ids.js';

export type AuditActorType = 'user' | 'admin' | 'system';

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
}

export interface RecordAuditOptions {
  db: Database;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Shallow key-by-key diff: `{ field: { before, after } }` for every field
 * present in either object whose values differ (via JSON string comparison,
 * so nested objects/arrays are compared by value). */
export function diffObjects(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff[key] = { before: b ?? null, after: a ?? null };
    }
  }
  return diff;
}

/**
 * Writes one audit_logs row: `actor` performed `action` on `entityType`
 * `entityId`, transitioning `before` -> `after`. Both `before`/`after` are
 * plain-object snapshots the caller already has in hand (a DTO or a raw row
 * with secrets stripped — this function does not redact anything itself, so
 * callers must never pass password hashes / token hashes / totp secrets).
 */
export async function recordAudit(options: RecordAuditOptions): Promise<void> {
  const { db, actor, action, entityType, entityId, before, after, ip, userAgent, requestId } = options;
  const diff = diffObjects(before ?? null, after ?? null);
  await db.insert(auditLogs).values({
    id: newId(),
    actorType: actor.type,
    actorId: actor.id,
    action,
    entityType,
    entityId,
    before: before ?? null,
    after: after ?? null,
    diff: Object.keys(diff).length > 0 ? diff : null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    requestId: requestId ?? null,
  });
}
