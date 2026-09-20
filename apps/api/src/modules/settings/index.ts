// /api/v1/settings — user_settings get/put with version + settings_history,
// validated by @sl/shared's userSettingsSchema plus admin-tunable governor
// ceilings read from system_config (docs/02-database.md §10, "system /
// feature flags").


import { settingsHistory, userSettings } from '@sl/db';
import { updateUserSettingsRequestSchema, userSettingsSchema, type UserSettings } from '@sl/shared';
import { desc, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { getOrCreateUserSettings } from '../../lib/settings.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const GOVERNOR_CONFIG_KEYS = {
  actionsPerHour: 'governor.max_actions_per_hour',
  sessionLengthMinutes: 'governor.max_session_minutes',
  buyToSearchRatio: 'governor.max_buy_search_ratio',
  maxCoinFlowPerHour: 'governor.max_coin_flow_per_hour',
} as const;

/** Reads the admin-tunable governor ceilings from system_config and
 * validates the requested governor settings never exceed them (a user may
 * tighten their own budget, never loosen it past the plan-wide ceiling). */
async function assertWithinGovernorCeilings(db: FastifyInstance['db'], governor: UserSettings['governor']) {
  const rows = await db.query.systemConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  for (const [field, configKey] of Object.entries(GOVERNOR_CONFIG_KEYS) as [keyof typeof GOVERNOR_CONFIG_KEYS, string][]) {
    const ceiling = byKey.get(configKey);
    if (typeof ceiling !== 'number') continue; // not configured — absolute schema limits still apply
    const value = governor[field];
    if (value > ceiling) {
      throw AppErrors.validation(`${field} exceeds the plan's configured ceiling (${ceiling}).`, { field, value, ceiling });
    }
  }
}

export default fp(
  async function settingsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/settings',
      { onRequest: [fastify.authenticate], schema: { tags: ['settings'], response: { 200: userSettingsSchema } } },
      async (request) => {
        const { settings } = await getOrCreateUserSettings(fastify.db, request.authUser!.id);
        return settings;
      },
    );

    app.put(
      '/api/v1/settings',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: { tags: ['settings'], body: updateUserSettingsRequestSchema, response: { 200: userSettingsSchema } },
      },
      async (request) => {
        const current = await getOrCreateUserSettings(fastify.db, request.authUser!.id);
        const patch = request.body;

        const merged: UserSettings = {
          version: current.version + 1,
          targets: { ...current.settings.targets, ...patch.targets },
          budgets: { ...current.settings.budgets, ...patch.budgets },
          governor: { ...current.settings.governor, ...patch.governor },
          telemetryOptOut: patch.telemetryOptOut ?? current.settings.telemetryOptOut,
          notifications: { ...current.settings.notifications, ...patch.notifications },
        };

        const validated = userSettingsSchema.parse(merged);
        await assertWithinGovernorCeilings(fastify.db, validated.governor);

        await fastify.db.update(userSettings).set({ settings: validated, version: validated.version }).where(eq(userSettings.id, current.id));
        await fastify.db.insert(settingsHistory).values({
          id: newId(),
          userId: request.authUser!.id,
          settings: validated,
          version: validated.version,
          changedBy: request.authUser!.id,
        });

        return validated;
      },
    );

    app.get(
      '/api/v1/settings/history',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['settings'],
          response: {
            200: z.array(z.object({ version: z.number(), settings: userSettingsSchema, createdAt: z.string().datetime() })),
          },
        },
      },
      async (request) => {
        const rows = await fastify.db.query.settingsHistory.findMany({
          where: eq(settingsHistory.userId, request.authUser!.id),
          orderBy: [desc(settingsHistory.version)],
          limit: 50,
        });
        return rows.map((r) => ({ version: r.version, settings: r.settings as UserSettings, createdAt: r.createdAt.toISOString() }));
      },
    );
  },
  { name: 'module:settings', dependencies: ['auth', 'db', 'csrf'] },
);
