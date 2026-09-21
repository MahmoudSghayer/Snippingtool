// Admin plan CRUD. `plans.features` is stored as a JSONB
// `Record<featureKey, boolean>` (matches packages/db's seed data shape); the
// public-facing DTO (modules/plans) and the admin create/update request
// bodies both use a flat `string[]` of the *enabled* feature keys — these two
// small helpers convert between the two representations so nothing else in
// this module has to think about the JSONB shape directly.

import { plans, type Database } from '@sl/db';
import { and, eq, isNull } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

import type { PlanCreateRequest, PlanUpdateRequest } from '@sl/shared';

export function featuresArrayToJsonb(features: readonly string[]): Record<string, boolean> {
  const obj: Record<string, boolean> = {};
  for (const feature of features) obj[feature] = true;
  return obj;
}

export function featuresJsonbToArray(
  features: Record<string, unknown> | null | undefined,
): string[] {
  return Object.entries(features ?? {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key);
}

export type PlanRow = typeof plans.$inferSelect;

export async function listAllPlans(db: Database): Promise<PlanRow[]> {
  return db.query.plans.findMany({
    where: isNull(plans.deletedAt),
    orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
  });
}

function assertIntervalMatchesLifetime(input: { isLifetime: boolean; interval: string }): void {
  if (input.isLifetime && input.interval !== 'one_time') {
    throw AppErrors.validation('A lifetime plan must have interval "one_time".');
  }
  if (!input.isLifetime && input.interval === 'one_time') {
    throw AppErrors.validation('Only a lifetime plan may use interval "one_time".');
  }
}

export async function createPlan(
  db: Database,
  input: PlanCreateRequest,
  actorId: string,
): Promise<PlanRow> {
  assertIntervalMatchesLifetime(input);

  const existing = await db.query.plans.findFirst({
    where: and(eq(plans.code, input.code), isNull(plans.deletedAt)),
  });
  if (existing) throw AppErrors.conflict(`A plan with code "${input.code}" already exists.`);

  const [row] = await db
    .insert(plans)
    .values({
      id: newId(),
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency: input.currency,
      interval: input.interval,
      isLifetime: input.isLifetime,
      deviceLimit: input.deviceLimit,
      features: featuresArrayToJsonb(input.features),
      stripePriceId: input.stripePriceId ?? null,
      sortOrder: input.sortOrder,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning();
  return row!;
}

export async function updatePlan(
  db: Database,
  planId: string,
  input: PlanUpdateRequest,
  actorId: string,
): Promise<{ before: PlanRow; after: PlanRow }> {
  const existing = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!existing || existing.deletedAt) throw AppErrors.notFound('plan');

  const patch: Partial<typeof plans.$inferInsert> = { updatedBy: actorId };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.priceCents !== undefined) patch.priceCents = input.priceCents;
  if (input.deviceLimit !== undefined) patch.deviceLimit = input.deviceLimit;
  if (input.features !== undefined) patch.features = featuresArrayToJsonb(input.features);
  if (input.stripePriceId !== undefined) patch.stripePriceId = input.stripePriceId;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

  const [row] = await db.update(plans).set(patch).where(eq(plans.id, planId)).returning();
  return { before: existing, after: row! };
}

export async function archivePlan(
  db: Database,
  planId: string,
  actorId: string,
): Promise<{ before: PlanRow; after: PlanRow }> {
  const existing = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!existing || existing.deletedAt) throw AppErrors.notFound('plan');
  if (!existing.isActive) throw AppErrors.conflict('Plan is already archived.');

  const [row] = await db
    .update(plans)
    .set({ isActive: false, updatedBy: actorId })
    .where(eq(plans.id, planId))
    .returning();
  return { before: existing, after: row! };
}
