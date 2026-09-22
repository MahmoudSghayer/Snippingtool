// Device registration + plan device-limit enforcement, shared by
// modules/auth (login/mfa-verify) and modules/devices (list/rename/revoke).

import { devices, type Database } from '@sl/db';
import { deviceFingerprintSchema, type DeviceFingerprint } from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { AppErrors } from './errors.js';
import { newId } from './ids.js';

import type { EntitlementProvider } from './entitlements.js';

export interface RegisteredDevice {
  id: string;
  isNew: boolean;
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

  const existing = await db.query.devices.findFirst({
    where: and(
      eq(devices.userId, userId),
      eq(devices.fingerprintHash, parsed.fingerprint),
      isNull(devices.deletedAt),
    ),
  });

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
