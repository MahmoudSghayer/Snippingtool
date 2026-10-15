// Device registration, shared by modules/auth (login/mfa-verify),
// modules/extension (bootstrap) and modules/licenses (validate).

import { devices, type Database } from '@sl/db';
import { deviceFingerprintSchema, type DeviceFingerprint } from '@sl/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { fastHash } from './crypto.js';
import { newId } from './ids.js';

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
 * revoked one or creating a new row as needed. There is no device limit:
 * an account signs in from as many devices as it likes.
 */
export async function findOrRegisterDevice(
  db: Database,
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
