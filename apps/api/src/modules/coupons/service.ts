// Coupon validation and redemption. `free_days`/`lifetime` coupons apply
// entirely at this layer (no Stripe involvement — docs/05-subscriptions.md
// §8); `percent`/`fixed` coupons are validated here too, but the actual
// discount is applied by `modules/payments` at Stripe Checkout time.

import { coupons, couponRedemptions, plans, type Database } from '@sl/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

export type CouponRow = typeof coupons.$inferSelect;

export async function findActiveCouponByCode(
  db: Database,
  code: string,
): Promise<CouponRow | null> {
  const row = await db.query.coupons.findFirst({
    where: and(eq(coupons.code, code.toUpperCase()), isNull(coupons.deletedAt)),
  });
  return row ?? null;
}

export type CouponIneligibleReason =
  'NOT_FOUND' | 'EXPIRED' | 'MAX_REDEMPTIONS' | 'ALREADY_REDEEMED' | 'PLAN_NOT_ELIGIBLE';

export interface CouponEligibility {
  eligible: boolean;
  coupon: CouponRow | null;
  reason?: CouponIneligibleReason;
}

/** `userId` is optional — a pre-login/anonymous `POST /coupons/validate`
 * preview can't check the per-user redemption record, so that check is
 * skipped (and re-checked authoritatively at actual redemption time, which
 * always has a `userId`). */
export async function checkCouponEligibility(
  db: Database,
  code: string,
  planId: string,
  userId?: string,
): Promise<CouponEligibility> {
  const coupon = await findActiveCouponByCode(db, code);
  if (!coupon || !coupon.isActive) return { eligible: false, coupon: null, reason: 'NOT_FOUND' };
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now())
    return { eligible: false, coupon, reason: 'EXPIRED' };
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { eligible: false, coupon, reason: 'MAX_REDEMPTIONS' };
  }
  if (coupon.planIds.length > 0 && !coupon.planIds.includes(planId)) {
    return { eligible: false, coupon, reason: 'PLAN_NOT_ELIGIBLE' };
  }
  if (userId) {
    const existing = await db.query.couponRedemptions.findFirst({
      where: and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.userId, userId)),
    });
    if (existing) return { eligible: false, coupon, reason: 'ALREADY_REDEEMED' };
  }
  return { eligible: true, coupon };
}

/** Records a redemption and increments `redeemed_count`. Takes the already
 * -fetched `coupon` row (from `checkCouponEligibility`) rather than
 * re-reading it, both to save a query and so the increment is computed from
 * a value the caller already validated against `max_redemptions`. */
export async function redeemCoupon(
  db: Database,
  coupon: CouponRow,
  userId: string,
  subscriptionId: string | null,
): Promise<void> {
  await db
    .insert(couponRedemptions)
    .values({ id: newId(), couponId: coupon.id, userId, subscriptionId, redeemedAt: new Date() });
  await db
    .update(coupons)
    .set({ redeemedCount: coupon.redeemedCount + 1 })
    .where(eq(coupons.id, coupon.id));
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export async function listAllCoupons(db: Database): Promise<CouponRow[]> {
  return db.query.coupons.findMany({
    where: isNull(coupons.deletedAt),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

/** `coupons.plan_ids` stores `plans.id` uuids; the DTO (`CouponDto`) is
 * expressed in plan *codes*, which is what an admin actually typed when
 * creating the coupon and what every other DTO in this domain uses. */
export async function resolvePlanCodes(
  db: Database,
  planIds: readonly string[],
): Promise<string[]> {
  if (planIds.length === 0) return [];
  const rows = await db.query.plans.findMany({ where: inArray(plans.id, [...planIds]) });
  return rows.map((r) => r.code);
}

export interface CreateCouponInput {
  code: string;
  type: CouponRow['type'];
  value: number;
  planCodes: string[];
  maxRedemptions: number | null;
  expiresAt: string | null;
  createdBy: string;
}

export async function createCoupon(db: Database, input: CreateCouponInput): Promise<CouponRow> {
  const code = input.code.toUpperCase();
  const existing = await findActiveCouponByCode(db, code);
  if (existing) throw AppErrors.conflict(`A coupon with code "${code}" already exists.`);

  const planIds: string[] = [];
  for (const planCode of input.planCodes) {
    const plan = await db.query.plans.findFirst({
      where: and(eq(plans.code, planCode), isNull(plans.deletedAt)),
    });
    if (!plan) throw AppErrors.validation(`Unknown plan code "${planCode}".`);
    planIds.push(plan.id);
  }

  const [row] = await db
    .insert(coupons)
    .values({
      id: newId(),
      code,
      type: input.type,
      value: input.value,
      planIds,
      maxRedemptions: input.maxRedemptions,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      isActive: true,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row!;
}

export interface UpdateCouponInput {
  isActive?: boolean;
  maxRedemptions?: number | null;
  expiresAt?: string | null;
}

export async function updateCoupon(
  db: Database,
  couponId: string,
  input: UpdateCouponInput,
  actorId: string,
): Promise<{ before: CouponRow; after: CouponRow }> {
  const before = await db.query.coupons.findFirst({ where: eq(coupons.id, couponId) });
  if (!before || before.deletedAt) throw AppErrors.notFound('coupon');

  const patch: Partial<typeof coupons.$inferInsert> = { updatedBy: actorId };
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.maxRedemptions !== undefined) patch.maxRedemptions = input.maxRedemptions;
  if (input.expiresAt !== undefined)
    patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  const [after] = await db.update(coupons).set(patch).where(eq(coupons.id, couponId)).returning();
  return { before, after: after! };
}
