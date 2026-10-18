// /api/v1/extension/* — bootstrap, heartbeat, telemetry, errors, version,
// kill-switch, and the Nova AI page's recent searches. The MV3 background
// service worker's only server contact points (docs/01-architecture.md,
// "license bootstrap + heartbeat + offline grace").

import {
  devices,
  featureToggles,
  licenses,
  plans,
  subscriptions,
  userActivity,
  userRecentSearches,
  users,
} from '@sl/db';
import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  extensionErrorReportSchema,
  FEATURE_KEYS,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  isPlanCode,
  putRecentSearchesRequestSchema,
  recentSearchSchema,
  recentSearchesResponseSchema,
  telemetryFlushRequestSchema,
  type BootstrapResponse,
  type LicenseDto,
  type RecentSearchesResponse,
  type SubscriptionDto,
} from '@sl/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { findOrRegisterDevice } from '../../lib/devices.js';
import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';
import { getOrCreateUserSettings } from '../../lib/settings.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

async function isKillSwitchActive(fastify: FastifyInstance): Promise<boolean> {
  const row = await fastify.db.query.featureToggles.findFirst({
    where: eq(featureToggles.key, 'kill_switch'),
  });
  return row?.enabled ?? false;
}

/** `deviceId` if it is one of this user's active devices, else null. The
 * body's `deviceId` is only the client's claim: heartbeat signs an
 * entitlement blob for it, and the reports attribute rows to it. */
async function ownActiveDeviceId(
  fastify: FastifyInstance,
  userId: string,
  deviceId: string,
): Promise<string | null> {
  const device = await fastify.db.query.devices.findFirst({
    columns: { id: true },
    where: and(
      eq(devices.id, deviceId),
      eq(devices.userId, userId),
      eq(devices.status, 'active'),
      isNull(devices.deletedAt),
    ),
  });
  return device?.id ?? null;
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

/** The authenticated caller's own email — keyed only on the session's user
 * id, never on anything from the request body. Bootstrap only (heartbeat
 * does not return it). Never log the value. */
async function loadOwnEmail(fastify: FastifyInstance, userId: string): Promise<string> {
  const row = await fastify.db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true, deletedAt: true },
  });
  // authenticate() just loaded this same row, so a miss means the account was
  // removed mid-request.
  if (!row || row.deletedAt) throw AppErrors.tokenInvalid('Account no longer exists.');
  return row.email;
}

/** Ten real entries are a few KB of JSON, and ten of the longest the schema
 * allows, every character escaped, stay under 45 KB; anything near the
 * 1 MiB server default is not a recent-searches list. */
const RECENT_SEARCHES_BODY_LIMIT = 64 * 1024;

/** The caller's stored list as the API returns it. An entry a later,
 * stricter schema no longer accepts is left out rather than failing the
 * response. */
function toRecentSearchesResponse(
  row: { items: unknown[]; updatedAt: Date } | undefined,
): RecentSearchesResponse {
  if (!row) return { items: [], updatedAt: null };
  const items = row.items.flatMap((item) => {
    const parsed = recentSearchSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return { items, updatedAt: row.updatedAt.toISOString() };
}

export default fp(
  async function extensionModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/extension/bootstrap',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['extension'],
          body: bootstrapRequestSchema,
          response: { 200: bootstrapResponseSchema },
        },
      },
      async (request): Promise<BootstrapResponse> => {
        const userId = request.authUser!.id;
        const { id: deviceId } = await findOrRegisterDevice(
          fastify.db,
          userId,
          request.body.device,
          request.ip,
        );

        await fastify.db
          .update(devices)
          .set({ extensionVersion: request.body.extensionVersion })
          .where(eq(devices.id, deviceId));

        const [entitlementSnapshot, { settings }, killSwitchActive, dtos, email] =
          await Promise.all([
            fastify.entitlements.getEntitlements(userId),
            getOrCreateUserSettings(fastify.db, userId),
            isKillSwitchActive(fastify),
            loadSubscriptionAndLicenseDto(fastify, userId),
            loadOwnEmail(fastify, userId),
          ]);

        const entitlementBlob = await fastify.entitlements.signEntitlementBlob(
          entitlementSnapshot,
          userId,
          deviceId,
          killSwitchActive,
        );

        return {
          userId,
          email,
          deviceId,
          subscription: dtos.subscription,
          license: dtos.license,
          features: entitlementSnapshot.features.filter((f): f is (typeof FEATURE_KEYS)[number] =>
            (FEATURE_KEYS as readonly string[]).includes(f),
          ),
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
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['extension'],
          body: heartbeatRequestSchema,
          response: { 200: heartbeatResponseSchema },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const { deviceId, extensionVersion, engineState } = request.body;

        // Never sign a blob for a device that isn't the caller's, or that
        // was revoked. The extension keeps its cached blob until its next
        // bootstrap, which registers the device again within the limit.
        if (!(await ownActiveDeviceId(fastify, userId, deviceId))) throw AppErrors.deviceNotFound();
        await fastify.db
          .update(devices)
          .set({ lastSeenAt: new Date(), extensionVersion, lastIp: request.ip })
          .where(eq(devices.id, deviceId));

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
        const entitlementBlob = await fastify.entitlements.signEntitlementBlob(
          entitlementSnapshot,
          userId,
          deviceId,
          killSwitchActive,
        );

        return {
          deviceId,
          subscription: dtos.subscription,
          license: dtos.license,
          features: entitlementSnapshot.features.filter((f): f is (typeof FEATURE_KEYS)[number] =>
            (FEATURE_KEYS as readonly string[]).includes(f),
          ),
          settings,
          killSwitchActive,
          entitlementBlob,
          serverTime: new Date().toISOString(),
        };
      },
    );

    // Telemetry is part of the recorder, so it needs a live plan. Bootstrap,
    // heartbeat and error reports stay ungated: an expired user's extension
    // must still learn that it has expired, and still report its failures.
    app.post(
      '/api/v1/extension/telemetry',
      {
        onRequest: [fastify.requireFeature('ledger.recorder')],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: telemetryFlushRequestSchema,
          response: { 200: z.object({ accepted: z.number() }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const deviceId = await ownActiveDeviceId(fastify, userId, request.body.deviceId);
        const rows = request.body.events.map((e) => ({
          id: newId(),
          userId,
          deviceId,
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
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: extensionErrorReportSchema,
          response: { 200: z.object({ accepted: z.number() }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const deviceId = await ownActiveDeviceId(fastify, userId, request.body.deviceId);
        const rows = request.body.errors.map((e) => ({
          id: newId(),
          userId,
          deviceId,
          type: 'error' as const,
          metadata: {
            message: e.message,
            stack: e.stack ?? null,
            context: e.context ?? null,
            extensionVersion: request.body.extensionVersion,
          },
          occurredAt: new Date(e.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(userActivity).values(rows);
        return { accepted: rows.length };
      },
    );

    // The Nova AI page's Recent searches log, kept per account so every
    // browser the trader signs in on shows the same list (the extension
    // keeps a local copy for when this is unreachable). Read when the page
    // opens, replaced whole after a bot start. Ungated like bootstrap: it is
    // the user's own data whatever their plan, and keyed only on the
    // session's user id.
    app.get(
      '/api/v1/extension/recent-searches',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], response: { 200: recentSearchesResponseSchema } },
      },
      async (request): Promise<RecentSearchesResponse> => {
        const row = await fastify.db.query.userRecentSearches.findFirst({
          where: eq(userRecentSearches.userId, request.authUser!.id),
        });
        return toRecentSearchesResponse(row);
      },
    );

    app.put(
      '/api/v1/extension/recent-searches',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        bodyLimit: RECENT_SEARCHES_BODY_LIMIT,
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: putRecentSearchesRequestSchema,
          response: { 200: recentSearchesResponseSchema },
        },
      },
      async (request): Promise<RecentSearchesResponse> => {
        const userId = request.authUser!.id;
        const { items } = request.body;
        // One row per user (user_id is unique): the first save creates it,
        // every later one replaces the list.
        const [row] = await fastify.db
          .insert(userRecentSearches)
          .values({ id: newId(), userId, items })
          .onConflictDoUpdate({ target: userRecentSearches.userId, set: { items } })
          .returning();
        return toRecentSearchesResponse(row);
      },
    );

    app.get(
      '/api/v1/extension/version',
      {
        schema: {
          tags: ['extension'],
          response: { 200: z.object({ latestVersion: z.string(), updateUrl: z.string() }) },
        },
      },
      async () => ({
        latestVersion: fastify.config.EXTENSION_LATEST_VERSION,
        updateUrl: fastify.config.EXTENSION_UPDATE_URL,
      }),
    );

    app.get(
      '/api/v1/extension/kill-switch',
      { schema: { tags: ['extension'], response: { 200: z.object({ active: z.boolean() }) } } },
      async () => ({ active: await isKillSwitchActive(fastify) }),
    );
  },
  { name: 'module:extension', dependencies: ['auth', 'db', 'entitlements'] },
);
