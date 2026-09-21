// /api/v1/devices — list/rename/revoke the caller's own devices.

import { devices } from '@sl/db';
import { deviceDtoSchema, type DeviceDto } from '@sl/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { AppErrors } from '../../lib/errors.js';

import type { Device } from '@sl/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toDto(device: Device, currentDeviceId: string | null): DeviceDto {
  return {
    id: device.id,
    name: device.name,
    browser: device.browser,
    os: device.os,
    extensionVersion: device.extensionVersion,
    status: device.status,
    firstSeenAt: device.firstSeenAt.toISOString(),
    lastSeenAt: device.lastSeenAt.toISOString(),
    trustedAt: device.trustedAt ? device.trustedAt.toISOString() : null,
    isCurrent: device.id === currentDeviceId,
  };
}

export default fp(
  async function devicesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/devices',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['devices'], response: { 200: z.array(deviceDtoSchema) } },
      },
      async (request) => {
        const rows = await fastify.db.query.devices.findMany({
          where: and(eq(devices.userId, request.authUser!.id), isNull(devices.deletedAt)),
          orderBy: [desc(devices.lastSeenAt)],
        });
        return rows.map((d) => toDto(d, request.authUser!.deviceId));
      },
    );

    app.patch(
      '/api/v1/devices/:id',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['devices'],
          params: z.object({ id: z.string().uuid() }),
          body: z.object({ name: z.string().min(1).max(120) }),
          response: { 200: deviceDtoSchema },
        },
      },
      async (request) => {
        const device = await fastify.db.query.devices.findFirst({
          where: and(
            eq(devices.id, request.params.id),
            eq(devices.userId, request.authUser!.id),
            isNull(devices.deletedAt),
          ),
        });
        if (!device) throw AppErrors.deviceNotFound();

        const [updated] = await fastify.db
          .update(devices)
          .set({ name: request.body.name })
          .where(eq(devices.id, device.id))
          .returning();
        return toDto(updated!, request.authUser!.deviceId);
      },
    );

    app.delete(
      '/api/v1/devices/:id',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['devices'],
          params: z.object({ id: z.string().uuid() }),
          response: { 200: z.object({ revoked: z.literal(true) }) },
        },
      },
      async (request) => {
        const device = await fastify.db.query.devices.findFirst({
          where: and(
            eq(devices.id, request.params.id),
            eq(devices.userId, request.authUser!.id),
            isNull(devices.deletedAt),
          ),
        });
        if (!device) throw AppErrors.deviceNotFound();

        await fastify.db
          .update(devices)
          .set({ status: 'revoked' })
          .where(eq(devices.id, device.id));

        // Revoking a device also kills every session bound to it.
        const { sessions } = await import('@sl/db');
        await fastify.db
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'device_revoked' })
          .where(and(eq(sessions.deviceId, device.id), isNull(sessions.revokedAt)));

        await recordAudit({
          db: fastify.db,
          actor: { type: 'user', id: request.authUser!.id },
          action: 'device.revoked',
          entityType: 'device',
          entityId: device.id,
          before: { status: device.status },
          after: { status: 'revoked' },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return { revoked: true as const };
      },
    );
  },
  { name: 'module:devices', dependencies: ['auth', 'db', 'csrf'] },
);
