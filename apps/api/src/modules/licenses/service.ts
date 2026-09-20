// License issuance, lookup, device-limit enforcement and validation.
// Key generation/format/checksum is `@sl/shared`'s `license-key.ts` (this
// agent's own implementation, per docs/05-subscriptions.md §3) — never
// `apps/api/src/lib/crypto.ts`'s `generateLicenseKey()`, which is a
// different, simpler (no real checksum) helper the core agent added for its
// own possible use; this module's key format is the one documented and
// tested. Only `fastHash` (SHA-256) is reused from `lib/crypto.ts` for
// storage — license keys are already high-entropy random values, so the
// same "fast hash is fine, no brute-force benefit to argon2" reasoning that
// file documents for tokens applies here too.

import { randomBytes } from 'node:crypto';

import { devices, licenses, plans, subscriptions, type Database } from '@sl/db';
import { generateLicenseKey, LICENSE_KEY_RANDOM_BYTES, validateLicenseKeyFormat } from '@sl/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { fastHash } from '../../lib/crypto.js';
import { AppError, AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

import type { EntitlementProvider } from '../../lib/entitlements.js';

export type LicenseRow = typeof licenses.$inferSelect;

const KEY_PREFIX_LENGTH = 'SL-XXXX'.length;

/** Issues a brand-new license for a subscription. Retries key generation on
 * the astronomically unlikely event of a `key_hash` collision. */
export async function issueForSubscription(
  db: Database,
  input: { subscriptionId: string; userId: string; maxDevices: number; expiresAt: Date | null },
): Promise<{ row: LicenseRow; fullKey: string }> {
  let fullKey = '';
  let keyHash = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateLicenseKey(randomBytes(LICENSE_KEY_RANDOM_BYTES));
    const candidateHash = fastHash(candidate);
    const existing = await db.query.licenses.findFirst({ where: eq(licenses.keyHash, candidateHash) });
    if (!existing) {
      fullKey = candidate;
      keyHash = candidateHash;
      break;
    }
  }
  if (!fullKey) throw AppErrors.internal('Could not generate a unique license key after 5 attempts.');

  const [row] = await db
    .insert(licenses)
    .values({
      id: newId(),
      subscriptionId: input.subscriptionId,
      userId: input.userId,
      keyHash,
      keyPrefix: fullKey.slice(0, KEY_PREFIX_LENGTH),
      status: 'active',
      maxDevices: input.maxDevices,
      expiresAt: input.expiresAt,
    })
    .returning();

  return { row: row!, fullKey };
}

export async function revoke(db: Database, licenseId: string, reason: string): Promise<LicenseRow> {
  const [row] = await db
    .update(licenses)
    .set({ status: 'revoked', revokedAt: new Date(), revokedReason: reason })
    .where(eq(licenses.id, licenseId))
    .returning();
  if (!row) throw AppErrors.notFound('license');
  return row;
}

export async function findActiveForSubscription(db: Database, subscriptionId: string): Promise<LicenseRow | null> {
  const row = await db.query.licenses.findFirst({
    where: and(eq(licenses.subscriptionId, subscriptionId), eq(licenses.status, 'active'), isNull(licenses.deletedAt)),
    orderBy: [desc(licenses.createdAt)],
  });
  return row ?? null;
}

export async function findLatestForUser(db: Database, userId: string): Promise<LicenseRow | null> {
  const row = await db.query.licenses.findFirst({
    where: and(eq(licenses.userId, userId), isNull(licenses.deletedAt)),
    orderBy: [desc(licenses.createdAt)],
  });
  return row ?? null;
}

/** Revokes the user's current active license (if any) and issues a fresh
 * one for the same live subscription. Used by `POST /licenses/regenerate`. */
export async function regenerateForUser(
  db: Database,
  userId: string,
): Promise<{ row: LicenseRow; fullKey: string }> {
  const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'lifetime'] as const;
  const sub = await db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
    orderBy: [desc(subscriptions.createdAt)],
  });
  if (!sub || !(LIVE_STATUSES as readonly string[]).includes(sub.status)) {
    throw AppErrors.notFound('subscription');
  }

  const existing = await findActiveForSubscription(db, sub.id);
  if (existing) await revoke(db, existing.id, 'regenerated_by_user');

  const plan = await db.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
  const maxDevices = existing?.maxDevices ?? plan?.deviceLimit ?? 1;

  return issueForSubscription(db, {
    subscriptionId: sub.id,
    userId,
    maxDevices,
    expiresAt: sub.currentPeriodEnd,
  });
}

async function countActiveDevicesForLicense(db: Database, licenseId: string): Promise<number> {
  const rows = await db.query.devices.findMany({
    where: and(eq(devices.licenseId, licenseId), eq(devices.status, 'active'), isNull(devices.deletedAt)),
  });
  return rows.length;
}

export interface ValidateLicenseInput {
  licenseKey: string;
  device: {
    fingerprint: string;
    name?: string;
    browser?: string;
    os?: string;
    extensionVersion?: string;
  };
}

export interface ValidateLicenseResult {
  status: LicenseRow['status'];
  entitlements: Awaited<ReturnType<EntitlementProvider['getEntitlements']>>;
  entitlementJws: string;
}

/** `POST /licenses/validate` — the extension's entry point. Enforces format
 * + checksum, revoked/expired status, and `max_devices`, then returns a
 * freshly-signed entitlement blob via the shared `EntitlementProvider`. */
export async function validateLicense(
  db: Database,
  entitlementProvider: EntitlementProvider,
  input: ValidateLicenseInput,
): Promise<ValidateLicenseResult> {
  const format = validateLicenseKeyFormat(input.licenseKey);
  if (!format.valid || !format.normalised) {
    throw new AppError('LICENSE_INVALID', 'License key is malformed.', { reason: format.reason });
  }

  const keyHash = fastHash(format.normalised);
  const license = await db.query.licenses.findFirst({ where: eq(licenses.keyHash, keyHash) });
  if (!license || license.deletedAt) {
    throw new AppError('LICENSE_INVALID', 'License key not recognised.');
  }
  if (license.status === 'revoked') {
    throw new AppError('LICENSE_REVOKED', 'This license has been revoked.', {
      reason: license.revokedReason ?? undefined,
    });
  }

  const isExpiredByDate = license.expiresAt !== null && license.expiresAt.getTime() < Date.now();
  if (license.status === 'expired' || isExpiredByDate) {
    if (license.status !== 'expired') {
      await db.update(licenses).set({ status: 'expired' }).where(eq(licenses.id, license.id));
    }
    throw new AppError('LICENSE_EXPIRED', 'This license has expired.');
  }

  const fingerprintHash = fastHash(input.device.fingerprint);
  const existingDevice = await db.query.devices.findFirst({
    where: and(eq(devices.userId, license.userId), eq(devices.fingerprintHash, fingerprintHash), isNull(devices.deletedAt)),
  });

  let deviceId: string;
  if (existingDevice) {
    await db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        licenseId: license.id,
        status: 'active',
        name: input.device.name ?? existingDevice.name,
        browser: input.device.browser ?? existingDevice.browser,
        os: input.device.os ?? existingDevice.os,
        extensionVersion: input.device.extensionVersion ?? existingDevice.extensionVersion,
      })
      .where(eq(devices.id, existingDevice.id));
    deviceId = existingDevice.id;
  } else {
    const activeCount = await countActiveDevicesForLicense(db, license.id);
    if (activeCount >= license.maxDevices) {
      throw new AppError('DEVICE_LIMIT_REACHED', 'Device limit reached for this license.', {
        maxDevices: license.maxDevices,
      });
    }
    const [created] = await db
      .insert(devices)
      .values({
        id: newId(),
        userId: license.userId,
        licenseId: license.id,
        fingerprintHash,
        name: input.device.name ?? null,
        browser: input.device.browser ?? null,
        os: input.device.os ?? null,
        extensionVersion: input.device.extensionVersion ?? null,
        status: 'active',
      })
      .returning();
    deviceId = created!.id;
  }

  await db.update(licenses).set({ lastValidatedAt: new Date() }).where(eq(licenses.id, license.id));

  const snapshot = await entitlementProvider.getEntitlements(license.userId);
  const entitlementJws = await entitlementProvider.signEntitlementBlob(snapshot, license.userId, deviceId);

  return { status: license.status, entitlements: snapshot, entitlementJws };
}
