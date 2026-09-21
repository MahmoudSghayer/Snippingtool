// EntitlementProvider: the interface `modules/extension`'s bootstrap/heartbeat
// routes depend on to answer "what is this user entitled to". Defined here so
// it is a stable seam — the subscriptions/payments agent may swap in a
// richer implementation (e.g. one that also considers grace periods after a
// failed Stripe charge) without `modules/extension` changing at all; it only
// ever imports this interface and calls `provider.getEntitlements(userId)`.
//
// The default implementation reads subscriptions/plans/licenses directly
// (the same tables the subscriptions agent owns the *mutation* side of) and
// signs the resulting blob with ENTITLEMENT_SIGNING_KEY so the extension can
// verify it offline during the grace window (docs/04-auth.md, "offline
// grace").

import { devices, licenses, subscriptions, plans, type Database } from '@sl/db';
import {
  type FeatureKey,
  PLAN_FEATURES,
  DEVICE_LIMITS,
  type PlanCode,
  isPlanCode,
} from '@sl/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { SignJWT, importPKCS8 } from 'jose';

export interface EntitlementSnapshot {
  plan: PlanCode | null;
  planName: string | null;
  status: string | null;
  features: FeatureKey[];
  deviceLimit: number;
  expiresAt: string | null;
  currentPeriodEnd: string | null;
  license: {
    keyPrefix: string;
    status: string;
    maxDevices: number;
    expiresAt: string | null;
  } | null;
}

export interface EntitlementProvider {
  getEntitlements(userId: string): Promise<EntitlementSnapshot>;
  /** Signs an entitlement snapshot into the opaque blob the extension caches
   * for its offline-grace window. */
  signEntitlementBlob(
    snapshot: EntitlementSnapshot,
    userId: string,
    deviceId: string,
  ): Promise<string>;
}

/** Reads the most recent non-deleted subscription for a user (any status —
 * callers decide what to do with e.g. `past_due`) plus its plan and an
 * active license, and builds a snapshot. This is intentionally simple (no
 * grace-period math) — the subscriptions agent may layer that on by
 * replacing the module's provider instance; the *shape* it must return stays
 * this one. */
export class DefaultEntitlementProvider implements EntitlementProvider {
  constructor(
    private readonly db: Database,
    private readonly signingKeyPem: string | undefined,
  ) {}

  async getEntitlements(userId: string): Promise<EntitlementSnapshot> {
    const sub = await this.db.query.subscriptions.findFirst({
      where: and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
      orderBy: [desc(subscriptions.createdAt)],
    });

    if (!sub) {
      return {
        plan: null,
        planName: null,
        status: null,
        features: [],
        deviceLimit: DEVICE_LIMITS.trial,
        expiresAt: null,
        currentPeriodEnd: null,
        license: null,
      };
    }

    const plan = await this.db.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
    const planCode: PlanCode = plan && isPlanCode(plan.code) ? plan.code : 'trial';
    const active = new Set(['trialing', 'active', 'lifetime']);
    const features = active.has(sub.status) ? [...PLAN_FEATURES[planCode]] : [];

    const license = await this.db.query.licenses.findFirst({
      where: and(eq(licenses.subscriptionId, sub.id), isNull(licenses.deletedAt)),
      orderBy: [desc(licenses.createdAt)],
    });

    return {
      plan: planCode,
      planName: plan?.name ?? null,
      status: sub.status,
      features,
      deviceLimit: plan?.deviceLimit ?? DEVICE_LIMITS[planCode],
      expiresAt: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
      currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
      license: license
        ? {
            keyPrefix: license.keyPrefix,
            status: license.status,
            maxDevices: license.maxDevices,
            expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
          }
        : null,
    };
  }

  async signEntitlementBlob(
    snapshot: EntitlementSnapshot,
    userId: string,
    deviceId: string,
  ): Promise<string> {
    if (!this.signingKeyPem) {
      // Dev/test fallback: an unsigned-but-structured blob, clearly marked as
      // such. Never used when ENTITLEMENT_SIGNING_KEY is configured.
      return Buffer.from(JSON.stringify({ unsigned: true, snapshot, userId, deviceId })).toString(
        'base64url',
      );
    }
    const key = await importPKCS8(this.signingKeyPem, 'EdDSA');
    return new SignJWT({ snapshot, deviceId })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('26h') // outlives the 24h offline-grace window with margin
      .sign(key);
  }
}

/** Counts active (non-revoked) devices for a user — used both by
 * DEVICE_LIMIT_REACHED enforcement at login and by admin device listings. */
export async function countActiveDevices(db: Database, userId: string): Promise<number> {
  const rows = await db.query.devices.findMany({
    where: and(eq(devices.userId, userId), isNull(devices.deletedAt), eq(devices.status, 'active')),
  });
  return rows.length;
}
