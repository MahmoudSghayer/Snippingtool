// Device registration + plan device-limit enforcement, shared by
// modules/auth (login/mfa-verify) and modules/devices (list/rename/revoke).

import { devices, type Database } from '@sl/db';
import { deviceFingerprintSchema, type DeviceFingerprint } from '@sl/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { fastHash } from './crypto.js';
import { AppErrors } from './errors.js';
import { newId } from './ids.js';

import type { EntitlementProvider } from './entitlements.js';

export interface RegisteredDevice {
  id: string;
  isNew: boolean;
}

export type DeviceRow = typeof devices.$inferSelect;

/**
 * The user's live device row for a fingerprint. `devices.fingerprint_hash`
 * holds the fingerprint exactly as the client sends it: the client value is
 * already a salted hash (apps/extension/src/lib/fingerprint.ts) or a random
 * id (the dashboard), never raw browser data. Licence validation used to
 * store `fastHash(fingerprint)` instead, so the same browser could hold two
 * rows. A legacy row is still recognised: it is rewritten to the plain
 * fingerprint, or, when a plain row already exists, dropped as a duplicate.
 * Shared by login/bootstrap (below) and licenses/service.ts.
 */
export async function findDeviceByFingerprint(
  db: Database,
  userId: string,
  fingerprint: string,
): Promise<DeviceRow | undefined> {
  const legacyHash = fastHash(fingerprint);
  const candidates = await db.query.devices.findMany({
    where: and(
      eq(devices.userId, userId),
      inArray(devices.fingerprintHash, [fingerprint, legacyHash]),
      isNull(devices.deletedAt),
    ),
  });
  const current = candidates.find((d) => d.fingerprintHash === fingerprint);
  const legacy = candidates.find((d) => d.fingerprintHash === legacyHash);
  if (!legacy) return current;
  if (current) {
    await db
      .update(devices)
      .set({ status: 'revoked', deletedAt: new Date() })
      .where(eq(devices.id, legacy.id));
    return current;
  }
  await db.update(devices).set({ fingerprintHash: fingerprint }).where(eq(devices.id, legacy.id));
  return { ...legacy, fingerprintHash: fingerprint };
}

/**
 * Finds the device matching (userId, fingerprintHash), reactivating a
 * revoked one or creating a new row as needed, enforcing the plan's device
 * limit (`DEVICE_LIMIT_REACHED`, with the current active-device list so the
 * client can offer "revoke one of these") whenever a *new* device would be
 * added on top of an already-full set. Logging back in from an
 * already-active device never counts against the limit.
 */
export async function findOrRegisterDevice(
  db: Database,
  entitlements: EntitlementProvider,
  userId: string,
  device: DeviceFingerprint,
  ip: string | null,
): Promise<RegisteredDevice> {
  const parsed = deviceFingerprintSchema.parse(device);

  const existing = await findDeviceByFingerprint(db, userId, parsed.fingerprint);

  if (existing && existing.status === 'active') {
    await db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        lastIp: ip,
        name: parsed.name ?? existing.name,
        browser: parsed.browser ?? existing.browser,
        os: parsed.os ?? existing.os,
        extensionVersion: parsed.extensionVersion ?? existing.extensionVersion,
      })
      .where(eq(devices.id, existing.id));
    return { id: existing.id, isNew: false };
  }

  const { deviceLimit } = await entitlements.getEntitlements(userId);
  const activeDevices = await db.query.devices.findMany({
    where: and(eq(devices.userId, userId), isNull(devices.deletedAt), eq(devices.status, 'active')),
  });

  if (activeDevices.length >= deviceLimit) {
    throw AppErrors.deviceLimitReached(
      activeDevices.map((d) => ({
        id: d.id,
        name: d.name,
        browser: d.browser,
        os: d.os,
        lastSeenAt: d.lastSeenAt.toISOString(),
      })),
    );
  }

  if (existing) {
    // Revoked device, re-registering: reactivate in place.
    await db
      .update(devices)
      .set({
        status: 'active',
        lastSeenAt: new Date(),
        lastIp: ip,
        name: parsed.name ?? existing.name,
        browser: parsed.browser ?? existing.browser,
        os: parsed.os ?? existing.os,
        extensionVersion: parsed.extensionVersion ?? existing.extensionVersion,
        trustedAt: null,
      })
      .where(eq(devices.id, existing.id));
    return { id: existing.id, isNew: false };
  }

  const id = newId();
  await db.insert(devices).values({
    id,
    userId,
    fingerprintHash: parsed.fingerprint,
    name: parsed.name ?? null,
    browser: parsed.browser ?? null,
    os: parsed.os ?? null,
    extensionVersion: parsed.extensionVersion ?? null,
    lastIp: ip,
    status: 'active',
  });
  return { id, isNew: true };
}
