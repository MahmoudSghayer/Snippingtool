// /api/v1/extension/* — bootstrap, heartbeat, telemetry, errors, version,
// kill-switch, the Nova AI page's recent searches, bot settings and Gallery
// list, and the open trades every browser's trade lifecycle follows. The
// MV3 background service worker's only server contact points
// (docs/01-architecture.md, "license bootstrap + heartbeat + offline
// grace").

import {
  devices,
  featureToggles,
  licenses,
  plans,
  subscriptions,
  trades,
  userActivity,
  userBotSettings,
  userGallery,
  userGalleryCompletions,
  userGalleryOwned,
  userRecentSearches,
  users,
  type Database,
} from '@sl/db';
import {
  addGalleryOwnedRequestSchema,
  addGalleryOwnedResponseSchema,
  botSettingsSchema,
  botSettingsSyncResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  extensionErrorReportSchema,
  FEATURE_KEYS,
  galleryCompletionsQuerySchema,
  galleryCompletionsResponseSchema,
  galleryOwnedResponseSchema,
  gallerySyncResponseSchema,
  galleryStateSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  isPlanCode,
  OPEN_TRADES_MAX,
  OPEN_TRADES_WINDOW_DAYS,
  openTradeSchema,
  openTradesResponseSchema,
  putBotSettingsRequestSchema,
  putGalleryRequestSchema,
  putGalleryResponseSchema,
  putRecentSearchesRequestSchema,
  recentSearchSchema,
  recentSearchesResponseSchema,
  telemetryFlushRequestSchema,
  type BootstrapResponse,
  type BotSettingsSyncResponse,
  type GalleryCompletionsResponse,
  type GalleryGrade,
  type GalleryState,
  type GallerySyncResponse,
  type LicenseDto,
  type AddGalleryOwnedResponse,
  type GalleryOwnedResponse,
  type OpenTrade,
  type OpenTradesResponse,
  type PutGalleryResponse,
  type RecentSearchesResponse,
  type SubscriptionDto,
} from '@sl/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { findOrRegisterDevice } from '../../lib/devices.js';
import { AppErrors } from '../../lib/errors.js';
import { recordExtensionInstall } from '../../lib/extension-installs.js';
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

/** The device if `deviceId` is one of this user's active devices, else
 * null. The body's `deviceId` is only the client's claim: heartbeat signs an
 * entitlement blob for it, and the reports attribute rows to it. */
async function ownActiveDevice(
  fastify: FastifyInstance,
  userId: string,
  deviceId: string,
): Promise<{ id: string; browser: string | null } | null> {
  const device = await fastify.db.query.devices.findFirst({
    columns: { id: true, browser: true },
    where: and(
      eq(devices.id, deviceId),
      eq(devices.userId, userId),
      eq(devices.status, 'active'),
      isNull(devices.deletedAt),
    ),
  });
  return device ?? null;
}

async function ownActiveDeviceId(
  fastify: FastifyInstance,
  userId: string,
  deviceId: string,
): Promise<string | null> {
  return (await ownActiveDevice(fastify, userId, deviceId))?.id ?? null;
}

/** Keeps `extension_installs` current (lib/extension-installs.ts) from the
 * two calls every install makes: bootstrap on start, heartbeat every 10
 * minutes. Bookkeeping only: a failure is logged, never returned to the
 * extension, whose licence check must not depend on it. */
async function touchInstall(
  fastify: FastifyInstance,
  report: Parameters<typeof recordExtensionInstall>[1],
): Promise<void> {
  try {
    await recordExtensionInstall(fastify.db, report);
  } catch (err) {
    fastify.log.warn({ err }, 'extension install bookkeeping failed (non-fatal)');
  }
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

/** A bot settings document is about 1 KB of JSON; anything near the 1 MiB
 * server default is not one. */
const BOT_SETTINGS_BODY_LIMIT = 32 * 1024;

/** The caller's stored bot settings as the API returns them. A document a
 * later schema no longer accepts reads as none rather than failing the
 * response: the extension then keeps its local copy. */
function toBotSettingsResponse(
  row: { settings: Record<string, unknown>; updatedAt: Date } | undefined,
): BotSettingsSyncResponse {
  if (!row) return { settings: null, updatedAt: null };
  const parsed = botSettingsSchema.safeParse(row.settings);
  return { settings: parsed.success ? parsed.data : null, updatedAt: row.updatedAt.toISOString() };
}

/** A Gallery list at every limit (300 cards with every field at its
 * longest, 40 Sets, 500 completed Sets with their times) is about 460 KiB
 * of JSON, 600 KiB when every name is quotes JSON escapes
 * (__tests__/gallery.test.ts measures both); a real one is a few dozen KB. */
const GALLERY_BODY_LIMIT = 1024 * 1024;

/** The caller's stored Gallery list as the API returns it. A list a later
 * schema no longer accepts reads as none rather than failing the response:
 * the extension then keeps its local copy. */
function toGalleryResponse(
  row: { state: Record<string, unknown>; updatedAt: Date } | undefined,
): GallerySyncResponse {
  if (!row) return { state: null, updatedAt: null };
  const parsed = galleryStateSchema.safeParse(row.state);
  return { state: parsed.success ? parsed.data : null, updatedAt: row.updatedAt.toISOString() };
}

/** A Drizzle transaction handle (what `db.transaction(cb)` passes `cb`). */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const GALLERY_GRADE_SET: ReadonlySet<string> = new Set(['D', 'C', 'B', 'A', 'S']);

/** The Set ids a stored list marks completed. The row is whatever an
 * earlier build saved (`toGalleryResponse` reads one the schema no longer
 * accepts as none), so only the one array is read, and only its numbers. */
function completedIdsOf(state: Record<string, unknown> | undefined): Set<number> {
  const ids = state?.completed;
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.filter((id): id is number => Number.isInteger(id) && id > 0));
}

/**
 * Keeps the account's log of completed Sets (user_gallery_completions,
 * 0043) in step with a list being saved: a Set id newly in `completed` is
 * logged with the name, grade, tokens and time the list carries (its id
 * and the save's time when it carries none), and one no longer there is
 * marked undone. A re-send of the same list logs nothing twice (the unique
 * constraint on the completion time). The list stays the source of truth
 * for what stands completed; the log remembers it after the list is
 * cleared, reset or capped.
 */
async function logCompletions(
  tx: Transaction,
  userId: string,
  before: Record<string, unknown> | undefined,
  after: GalleryState,
): Promise<void> {
  const was = completedIdsOf(before);
  const now = new Set(after.completed ?? []);
  const added = [...now].filter((id) => !was.has(id));
  const gone = [...was].filter((id) => !now.has(id));
  if (added.length > 0) {
    const sets = new Map((after.sets ?? []).map((s) => [s.id, s]));
    await tx
      .insert(userGalleryCompletions)
      .values(
        added.map((setId) => {
          const set = sets.get(setId);
          // The list's time for it (epoch ms); the save's own when it has
          // none, or one no Date can hold (the schema allows any positive
          // integer, and an invalid Date is not a timestamptz).
          const at = new Date(after.completedAt?.[String(setId)] ?? NaN);
          const grade = after.completedGrade?.[String(setId)] ?? set?.grade ?? null;
          return {
            id: newId(),
            userId,
            setId,
            setName: set?.name ?? `Set #${setId}`,
            grade: grade !== null && GALLERY_GRADE_SET.has(grade) ? grade : null,
            tokens: set?.tokens ?? null,
            completedAt: Number.isNaN(at.getTime()) ? new Date() : at,
          };
        }),
      )
      .onConflictDoNothing();
  }
  if (gone.length > 0) {
    await tx
      .update(userGalleryCompletions)
      .set({ undoneAt: new Date() })
      .where(
        and(
          eq(userGalleryCompletions.userId, userId),
          inArray(userGalleryCompletions.setId, gone),
          isNull(userGalleryCompletions.undoneAt),
        ),
      );
  }
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
        await touchInstall(fastify, {
          installId: deviceId,
          userId,
          version: request.body.extensionVersion,
          browser: request.body.device.browser,
        });

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
        const device = await ownActiveDevice(fastify, userId, deviceId);
        if (!device) throw AppErrors.deviceNotFound();
        await fastify.db
          .update(devices)
          .set({ lastSeenAt: new Date(), extensionVersion, lastIp: request.ip })
          .where(eq(devices.id, deviceId));
        await touchInstall(fastify, {
          installId: deviceId,
          userId,
          version: extensionVersion,
          browser: device.browser,
        });

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

    // The Nova AI bot's settings, kept per account so every browser the
    // trader signs in on starts with the ones they chose (the extension
    // keeps a local copy for when this is unreachable). Read when the bot
    // page loads them, replaced whole on every save. Ungated like
    // recent-searches: the user's own data whatever their plan.
    app.get(
      '/api/v1/extension/bot-settings',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], response: { 200: botSettingsSyncResponseSchema } },
      },
      async (request): Promise<BotSettingsSyncResponse> => {
        const row = await fastify.db.query.userBotSettings.findFirst({
          where: eq(userBotSettings.userId, request.authUser!.id),
        });
        return toBotSettingsResponse(row);
      },
    );

    app.put(
      '/api/v1/extension/bot-settings',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        bodyLimit: BOT_SETTINGS_BODY_LIMIT,
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: putBotSettingsRequestSchema,
          response: { 200: botSettingsSyncResponseSchema },
        },
      },
      async (request): Promise<BotSettingsSyncResponse> => {
        const userId = request.authUser!.id;
        const { settings } = request.body;
        // One row per user (user_id is unique): the first save creates it,
        // every later one replaces the document.
        const [row] = await fastify.db
          .insert(userBotSettings)
          .values({ id: newId(), userId, settings })
          .onConflictDoUpdate({ target: userBotSettings.userId, set: { settings } })
          .returning();
        return toBotSettingsResponse(row);
      },
    );

    // Nova AI's Gallery mode list (its cards and their progress, the fut.gg
    // Sets on it, the Sets marked completed and when), kept per account so
    // every browser the trader signs in on shows which Sets are done and
    // which are not (the extension keeps a local copy for when this is
    // unreachable). Read when the bot page loads, replaced whole at most
    // every 2 s while the list changes. Ungated like bot-settings: the
    // user's own data whatever their plan.
    app.get(
      '/api/v1/extension/gallery',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], response: { 200: gallerySyncResponseSchema } },
      },
      async (request): Promise<GallerySyncResponse> => {
        const row = await fastify.db.query.userGallery.findFirst({
          where: eq(userGallery.userId, request.authUser!.id),
        });
        return toGalleryResponse(row);
      },
    );

    app.put(
      '/api/v1/extension/gallery',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        bodyLimit: GALLERY_BODY_LIMIT,
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: putGalleryRequestSchema,
          response: { 200: putGalleryResponseSchema },
        },
      },
      async (request): Promise<PutGalleryResponse> => {
        const userId = request.authUser!.id;
        const { state } = request.body;
        return fastify.db.transaction(async (tx) => {
          // What the list marked completed before this save, for the log.
          const before = await tx.query.userGallery.findFirst({
            where: eq(userGallery.userId, userId),
            columns: { state: true },
          });
          // One row per user (user_id is unique): the first save creates it,
          // every later one replaces the list.
          const [row] = await tx
            .insert(userGallery)
            .values({ id: newId(), userId, state })
            .onConflictDoUpdate({ target: userGallery.userId, set: { state } })
            .returning({ updatedAt: userGallery.updatedAt });
          await logCompletions(tx, userId, before?.state, state);
          return { updatedAt: row!.updatedAt.toISOString() };
        });
      },
    );

    // The account's log of completed Sets (user_gallery_completions, 0043),
    // newest first: what the trader finished lately, to Autocomplete in the
    // game, on any browser and on the dashboard's Gallery section. Kept
    // after the list is cleared or reset; a Set undone is hidden unless
    // asked for (`undone=include`). Ungated like the list itself.
    app.get(
      '/api/v1/extension/gallery/completions',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          querystring: galleryCompletionsQuerySchema,
          response: { 200: galleryCompletionsResponseSchema },
        },
      },
      async (request): Promise<GalleryCompletionsResponse> => {
        const userId = request.authUser!.id;
        const { limit, undone } = request.query;
        const rows = await fastify.db
          .select({
            setId: userGalleryCompletions.setId,
            setName: userGalleryCompletions.setName,
            grade: userGalleryCompletions.grade,
            tokens: userGalleryCompletions.tokens,
            completedAt: userGalleryCompletions.completedAt,
            undoneAt: userGalleryCompletions.undoneAt,
          })
          .from(userGalleryCompletions)
          .where(
            and(
              eq(userGalleryCompletions.userId, userId),
              undone === 'include' ? undefined : isNull(userGalleryCompletions.undoneAt),
            ),
          )
          .orderBy(desc(userGalleryCompletions.completedAt), desc(userGalleryCompletions.createdAt))
          .limit(limit);
        return {
          items: rows.map((r) => ({
            setId: r.setId,
            name: r.setName,
            grade:
              r.grade !== null && GALLERY_GRADE_SET.has(r.grade) ? (r.grade as GalleryGrade) : null,
            tokens: r.tokens,
            completedAt: r.completedAt.toISOString(),
            undoneAt: r.undoneAt?.toISOString() ?? null,
          })),
        };
      },
    );

    // The account's collected-card catalogue: every card id put through the
    // club in Gallery mode (user_gallery_owned, 0042). A card counts for FC's
    // Gallery once it has passed through the club, so Nova lists it again and
    // sells it; this is what remembers it stays collected, after it is sold
    // and on any browser. Read on bot start and merged into the planner's
    // `owned` so a catalogued card is never bought twice. Ungated like
    // gallery/bot-settings: the user's own data whatever their plan.
    app.get(
      '/api/v1/extension/gallery/owned',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], response: { 200: galleryOwnedResponseSchema } },
      },
      async (request): Promise<GalleryOwnedResponse> => {
        const rows = await fastify.db
          .select({ resourceId: userGalleryOwned.resourceId })
          .from(userGalleryOwned)
          .where(eq(userGalleryOwned.userId, request.authUser!.id));
        return { resourceIds: rows.map((r) => r.resourceId) };
      },
    );

    // Adds the card ids the bot has just clubbed. Idempotent: ids already
    // catalogued are ignored (the composite PK), so a re-send is cheap.
    app.post(
      '/api/v1/extension/gallery/owned',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['extension'],
          body: addGalleryOwnedRequestSchema,
          response: { 200: addGalleryOwnedResponseSchema },
        },
      },
      async (request): Promise<AddGalleryOwnedResponse> => {
        const userId = request.authUser!.id;
        const ids = [...new Set(request.body.resourceIds)];
        const inserted = await fastify.db
          .insert(userGalleryOwned)
          .values(ids.map((resourceId) => ({ userId, resourceId })))
          .onConflictDoNothing()
          .returning({ resourceId: userGalleryOwned.resourceId });
        const [row] = await fastify.db
          .select({ total: sql<number>`count(*)::int` })
          .from(userGalleryOwned)
          .where(eq(userGalleryOwned.userId, userId));
        return { added: inserted.length, total: row?.total ?? 0 };
      },
    );

    // The caller's trades still `bought` that carry EA's item id, newest
    // first: each browser's trade lifecycle (apps/extension/src/lib/
    // trade-lifecycle.ts) follows these cards too, so a card bought in one
    // browser and sold while the bot runs in another still has its sale
    // reported, on the original buy's tradeId. Read on bot start, at boot
    // and every ~15 minutes while the bot runs. Plan-gated like
    // `/trades/batch`, whose sale reports this feeds.
    app.get(
      '/api/v1/extension/open-trades',
      {
        onRequest: [fastify.requireFeature('ledger.recorder')],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['extension'], response: { 200: openTradesResponseSchema } },
      },
      async (request): Promise<OpenTradesResponse> => {
        const since = new Date(Date.now() - OPEN_TRADES_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const rows = await fastify.db
          .select({
            tradeId: trades.tradeId,
            itemId: trades.itemId,
            resourceId: trades.resourceId,
            rating: trades.rating,
            buyPrice: trades.buyPrice,
            boughtAt: trades.boughtAt,
          })
          .from(trades)
          .where(
            and(
              eq(trades.userId, request.authUser!.id),
              eq(trades.status, 'bought'),
              isNull(trades.deletedAt),
              isNotNull(trades.itemId),
              gte(trades.boughtAt, since),
            ),
          )
          .orderBy(desc(trades.boughtAt), desc(trades.id))
          .limit(OPEN_TRADES_MAX + 1);
        // Every stored value came through the ingest bounds, but a row that
        // somehow does not fit is left out rather than failing the response.
        const items: OpenTrade[] = [];
        for (const row of rows.slice(0, OPEN_TRADES_MAX)) {
          const parsed = openTradeSchema.safeParse({
            ...row,
            resourceId: Number(row.resourceId),
            boughtAt: row.boughtAt?.toISOString(),
          });
          if (parsed.success) items.push(parsed.data);
        }
        return { items, truncated: rows.length > OPEN_TRADES_MAX };
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
