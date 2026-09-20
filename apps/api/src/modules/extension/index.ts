// /api/v1/extension/* — bootstrap, heartbeat, telemetry, errors, version,
// kill-switch. The MV3 background service worker's only server contact
// points (docs/01-architecture.md, "license bootstrap + heartbeat + offline
// grace").


import { devices, featureToggles, licenses, plans, subscriptions, userActivity } from '@sl/db';
import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  extensionErrorReportSchema,
  FEATURE_KEYS,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  isPlanCode,
  telemetryFlushRequestSchema,
  type BootstrapResponse,
  type LicenseDto,
  type SubscriptionDto,
} from '@sl/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { findOrRegisterDevice } from '../../lib/devices.js';
import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';
import { getOrCreateUserSettings } from '../../lib/settings.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

async function isKillSwitchActive(fastify: FastifyInstance): Promise<boolean> {
  const row = await fastify.db.query.featureToggles.findFirst({ where: eq(featureToggles.key, 'kill_switch') });
  return row?.enabled ?? false;
}

async function loadSubscriptionAndLicenseDto(
  fastify: FastifyInstance,
  userId: string,
): Promise<{ subscription: SubscriptionDto | null; license: LicenseDto | null }> {
  const sub = await fastify.db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
    orderBy: [desc(subscriptions.createdAt)],
  });
  if (!sub) return { subscription: null, license: null };

  const plan = await fastify.db.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
  const subscription: SubscriptionDto | null = plan
    ? {
        id: sub.id,
        plan: {
          id: plan.id,
          code: isPlanCode(plan.code) ? plan.code : 'trial',
          name: plan.name,
          priceCents: plan.priceCents,
          currency: plan.currency,
          interval: plan.interval as SubscriptionDto['plan']['interval'],
          deviceLimit: plan.deviceLimit,
          features: Object.keys(plan.features ?? {}),
          isLifetime: plan.isLifetime,
        },
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart ? sub.currentPeriodStart.toISOString() : null,
        currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
        trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        autoRenew: sub.autoRenew,
      }
    : null;

  const licenseRow = await fastify.db.query.licenses.findFirst({
    where: and(eq(licenses.subscriptionId, sub.id), isNull(licenses.deletedAt)),
    orderBy: [desc(licenses.createdAt)],
  });
  const license: LicenseDto | null = licenseRow
    ? {
        keyPrefix: licenseRow.keyPrefix,
        status: licenseRow.status,
        maxDevices: licenseRow.maxDevices,
        expiresAt: licenseRow.expiresAt ? licenseRow.expiresAt.toISOString() : null,
      }
    : null;

  return { subscription, license };
}

export default fp(
  async function extensionModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/extension/bootstrap',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['extension'], body: bootstrapRequestSchema, response: { 200: bootstrapResponseSchema } },
      },
      async (request): Promise<BootstrapResponse> => {
        const userId = request.authUser!.id;
        const { id: deviceId } = await findOrRegisterDevice(fastify.db, fastify.entitlements, userId, request.body.device, request.ip);

        await fastify.db
          .update(devices)
          .set({ extensionVersion: request.body.extensionVersion })
          .where(eq(devices.id, deviceId));

        const [entitlementSnapshot, { settings }, killSwitchActive, dtos] = await Promise.all([
          fastify.entitlements.getEntitlements(userId),
          getOrCreateUserSettings(fastify.db, userId),
          isKillSwitchActive(fastify),
          loadSubscriptionAndLicenseDto(fastify, userId),
        ]);

        const entitlementBlob = await fastify.entitlements.signEntitlementBlob(entitlementSnapshot, userId, deviceId);

        return {
          userId,
          deviceId,
          subscription: dtos.subscription,
          license: dtos.license,
          features: entitlementSnapshot.features.filter((f): f is (typeof FEATURE_KEYS)[number] => (FEATURE_KEYS as readonly string[]).includes(f)),
          settings,
          killSwitchActive,
          entitlementBlob,
          serverTime: new Date().toISOString(),
        };
      },
    );

    app.post(
      '/api/v1/extension/heartbeat',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['extension'], body: heartbeatRequestSchema, response: { 200: heartbeatResponseSchema } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const { deviceId, extensionVersion, engineState } = request.body;

        const device = await fastify.db.query.devices.findFirst({
          where: and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.deletedAt)),
        });
        if (device) {
          await fastify.db.update(devices).set({ lastSeenAt: new Date(), extensionVersion, lastIp: request.ip }).where(eq(devices.id, deviceId));
        }

        await fastify.db.insert(userActivity).values({
          id: newId(),
          userId,
          deviceId,
          type: 'heartbeat',
          metadata: { extensionVersion, engineState },
        });

        const [entitlementSnapshot, { settings }, killSwitchActive, dtos] = await Promise.all([
          fastify.entitlements.getEntitlements(userId),
          getOrCreateUserSettings(fastify.db, userId),
          isKillSwitchActive(fastify),
          loadSubscriptionAndLicenseDto(fastify, userId),
        ]);
        const entitlementBlob = await fastify.entitlements.signEntitlementBlob(entitlementSnapshot, userId, deviceId);

        return {
          deviceId,
          subscription: dtos.subscription,
          license: dtos.license,
          features: entitlementSnapshot.features.filter((f): f is (typeof FEATURE_KEYS)[number] => (FEATURE_KEYS as readonly string[]).includes(f)),
          settings,
          killSwitchActive,
          entitlementBlob,
          serverTime: new Date().toISOString(),
        };
      },
    );

    app.post(
      '/api/v1/extension/telemetry',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], body: telemetryFlushRequestSchema, response: { 200: z.object({ accepted: z.number() }) } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const rows = request.body.events.map((e) => ({
          id: newId(),
          userId,
          deviceId: request.body.deviceId,
          type: 'other' as const,
          metadata: { name: e.name, data: e.data ?? {} },
          occurredAt: new Date(e.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(userActivity).values(rows);
        return { accepted: rows.length };
      },
    );

    app.post(
      '/api/v1/extension/errors',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], body: extensionErrorReportSchema, response: { 200: z.object({ accepted: z.number() }) } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const rows = request.body.errors.map((e) => ({
          id: newId(),
          userId,
          deviceId: request.body.deviceId,
          type: 'error' as const,
          metadata: { message: e.message, stack: e.stack ?? null, context: e.context ?? null, extensionVersion: request.body.extensionVersion },
          occurredAt: new Date(e.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(userActivity).values(rows);
        return { accepted: rows.length };
      },
    );

    app.get(
      '/api/v1/extension/version',
      { schema: { tags: ['extension'], response: { 200: z.object({ latestVersion: z.string(), updateUrl: z.string() }) } } },
      async () => ({ latestVersion: fastify.config.EXTENSION_LATEST_VERSION, updateUrl: fastify.config.EXTENSION_UPDATE_URL }),
    );

    app.get(
      '/api/v1/extension/kill-switch',
      { schema: { tags: ['extension'], response: { 200: z.object({ active: z.boolean() }) } } },
      async () => ({ active: await isKillSwitchActive(fastify) }),
    );
  },
  { name: 'module:extension', dependencies: ['auth', 'db', 'entitlements'] },
);
