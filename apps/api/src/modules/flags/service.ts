// Abuse/fraud flag creation, listing and review. Written to by
// `modules/subscriptions` (trial abuse) and the `abuse.scan` job; read and
// reviewed/dismissed by `modules/admin-flags`.

import { flags, type Database } from '@sl/db';
import { and, eq } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

export type FlagRow = typeof flags.$inferSelect;

export interface CreateFlagInput {
  userId: string;
  kind: FlagRow['kind'];
  severity: FlagRow['severity'];
  evidence: Record<string, unknown>;
}

export async function createFlag(db: Database, input: CreateFlagInput): Promise<FlagRow> {
  const [row] = await db
    .insert(flags)
    .values({
      id: newId(),
      userId: input.userId,
      kind: input.kind,
      severity: input.severity,
      evidence: input.evidence,
      status: 'open',
    })
    .returning();
  return row!;
}

export interface FlagListFilter {
  status?: FlagRow['status'];
  kind?: FlagRow['kind'];
  severity?: FlagRow['severity'];
  userId?: string;
}

export async function listFlags(db: Database, filter: FlagListFilter): Promise<FlagRow[]> {
  const conditions = [
    filter.status ? eq(flags.status, filter.status) : undefined,
    filter.kind ? eq(flags.kind, filter.kind) : undefined,
    filter.severity ? eq(flags.severity, filter.severity) : undefined,
    filter.userId ? eq(flags.userId, filter.userId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  return db.query.flags.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

export async function reviewFlag(
  db: Database,
  flagId: string,
  input: { status: 'reviewed' | 'dismissed'; reviewedBy: string },
): Promise<{ before: FlagRow; after: FlagRow }> {
  const before = await db.query.flags.findFirst({ where: eq(flags.id, flagId) });
  if (!before) throw AppErrors.notFound('flag');
  if (before.status !== 'open') throw AppErrors.conflict(`Flag is already ${before.status}.`);

  const [after] = await db
    .update(flags)
    .set({ status: input.status, reviewedBy: input.reviewedBy, reviewedAt: new Date() })
    .where(eq(flags.id, flagId))
    .returning();
  return { before, after: after! };
}
