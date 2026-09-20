// GET /subscriptions/me, POST /subscriptions/trial (with trial-abuse
// protection), POST /subscriptions/cancel, POST /subscriptions/resume.

import { devices, featureToggles, users } from '@sl/db';
import { deviceDtoSchema, entitlementSnapshotSchema, licenseDtoSchema, subscriptionDtoSchema } from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError, AppErrors } from '../../lib/errors.js';
import { findLatestForUser } from '../licenses/service.js';

import {
  cancelAtPeriodEnd,
  getLatestSubscriptionForUser,
  getPlanById,
  resumeCanceled,
  startTrial,
  toSubscriptionDto,
} from './service.js';

import type { FastifyInstance } from 'fastify';

const meResponseSchema = z.object({
  subscription: subscriptionDtoSchema.nullable(),
  license: licenseDtoSchema.nullable(),
  devices: z.array(deviceDtoSchema),
  entitlements: entitlementSnapshotSchema,
});

const trialResponseSchema = z.object({
  subscription: subscriptionDtoSchema,
  license: z.object({
    key: z.string(), // full key — returned exactly once, see docs/05-subscriptions.md §3
    keyPrefix: z.string(),
    maxDevices: z.number().int(),
    expiresAt: z.string().datetime().nullable(),
  }),
});

export default fp(
  async function subscriptionsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/subscriptions/me',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['subscriptions'],
          summary: 'Current subscription + license + devices + resolved entitlements.',
          response: { 200: meResponseSchema },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;

        const sub = await getLatestSubscriptionForUser(fastify.db, userId);
        const plan = sub ? await getPlanById(fastify.db, sub.planId) : null;
        const license = await findLatestForUser(fastify.db, userId);

        const deviceRows = await fastify.db.query.devices.findMany({
          where: and(eq(devices.userId, userId), isNull(devices.deletedAt)),
          orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
        });

        const entitlements = await fastify.entitlements.getEntitlements(userId);

        return {
          subscription: sub && plan ? toSubscriptionDto(sub, plan) : null,
          license: license
            ? {
                keyPrefix: license.keyPrefix,
                status: license.status,
                maxDevices: license.maxDevices,
                expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
              }
            : null,
          devices: deviceRows.map((d) => ({
            id: d.id,
            name: d.name,
            browser: d.browser,
            os: d.os,
            extensionVersion: d.extensionVersion,
            status: d.status,
            firstSeenAt: d.firstSeenAt.toISOString(),
            lastSeenAt: d.lastSeenAt.toISOString(),
            trustedAt: d.trustedAt ? d.trustedAt.toISOString() : null,
            isCurrent: d.id === request.authUser!.deviceId,
          })),
          entitlements,
        };
      },
    );

    app.post(
      '/api/v1/subscriptions/trial',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['subscriptions'],
          summary: 'Start a 7-day trial. Denied with TRIAL_ABUSE_DETECTED on abuse signals.',
          response: { 201: trialResponseSchema },
        },
      },
      async (request, reply) => {
        const userId = request.authUser!.id;

        const toggle = await fastify.db.query.featureToggles.findFirst({
          where: eq(featureToggles.key, 'trial.enabled'),
        });
        if (toggle && !toggle.enabled) {
          throw new AppError('SUBSCRIPTION_REQUIRED', 'Trials are currently disabled.');
        }

        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, userId) });
        if (!user) throw AppErrors.notFound('user');

        let fingerprintHash: string | null = null;
        const deviceId = request.authUser!.deviceId;
        if (deviceId) {
          const device = await fastify.db.query.devices.findFirst({ where: eq(devices.id, deviceId) });
          fingerprintHash = device?.fingerprintHash ?? null;
        }

        const result = await startTrial(fastify.db, fastify.redis, {
          userId,
          email: user.email,
          fingerprintHash,
          ip: request.ip,
          stripeCustomerId: user.stripeCustomerId,
        });

        if (result.blocked) {
          throw new AppError('TRIAL_ABUSE_DETECTED', 'Trial request denied.', {
            detectors: result.matches.map((m) => m.detector),
          });
        }

        return reply.status(201).send({
          subscription: toSubscriptionDto(result.subscription, result.plan),
          license: {
            key: result.license.key,
            keyPrefix: result.license.keyPrefix,
            maxDevices: result.license.maxDevices,
            expiresAt: result.license.expiresAt ? result.license.expiresAt.toISOString() : null,
          },
        });
      },
    );

    app.post(
      '/api/v1/subscriptions/cancel',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['subscriptions'],
          summary: 'Cancel at period end (stays active until current_period_end).',
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const row = await cancelAtPeriodEnd(fastify.db, fastify.redis, request.authUser!.id);
        const plan = await getPlanById(fastify.db, row.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');
        return toSubscriptionDto(row, plan);
      },
    );

    app.post(
      '/api/v1/subscriptions/resume',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['subscriptions'],
          summary: 'Undo a pending cancel-at-period-end, while still before the period end.',
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const row = await resumeCanceled(fastify.db, fastify.redis, request.authUser!.id);
        const plan = await getPlanById(fastify.db, row.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');
        return toSubscriptionDto(row, plan);
      },
    );
  },
  { name: 'module:subscriptions', dependencies: ['auth', 'db', 'redis', 'entitlements'] },
);
