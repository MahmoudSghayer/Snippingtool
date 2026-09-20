import { z } from 'zod';

import { deviceFingerprintSchema } from './auth.js';

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const deviceDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).nullable(),
  browser: z.string().min(1).max(60).nullable(),
  os: z.string().min(1).max(60).nullable(),
  extensionVersion: z.string().min(1).max(30).nullable(),
  status: z.enum(DEVICE_STATUSES),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  trustedAt: z.string().datetime().nullable(),
  isCurrent: z.boolean(),
});
export type DeviceDto = z.infer<typeof deviceDtoSchema>;

export const registerDeviceRequestSchema = deviceFingerprintSchema;
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const revokeDeviceRequestSchema = z.object({
  deviceId: z.string().uuid(),
});
export type RevokeDeviceRequest = z.infer<typeof revokeDeviceRequestSchema>;
