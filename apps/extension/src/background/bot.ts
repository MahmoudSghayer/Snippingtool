/*
 * bot.ts — background handlers for the Sniping Bot page: its settings
 * (`bot.settingsGet` / `bot.settingsSet`, `storage.local`, never sent to the
 * server), EA's player/club/league/nation lists for the Snipe Targets form
 * (`catalog.get` / `catalog.save`, see `model/catalog.ts`), and player names
 * for the log (`cards.names`).
 *
 * Names come from EA's player list when it has been captured, otherwise
 * from `/api/v1/market/cards/:resourceId`. A resolved name is
 * cached for good (a card's name does not change); an id the API has no name
 * for is cached as `null` for a day so a busy bot does not ask again on every
 * search.
 */
import {
  DEFAULT_BOT_SETTINGS,
  adapterCatalogSchema,
  botDailyUsageSchema,
  extBackgroundBotBudgetSetPayloadSchema,
  botSettingsSchema,
  type BotBudgetState,
  type BotDailyUsage,
  type BotSettings,
  type MarketCardHistoryResponse,
} from '@sl/shared';

import { apiJson } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { getLocal, setLocal } from '../lib/storage.js';

import type { Catalog } from '../model/catalog.js';

const SETTINGS_KEY = 'sl.bot.settings.v1';
const NAMES_KEY = 'sl.cards.names.v1';
const CATALOG_KEY = 'sl.catalog.v1';
const USAGE_KEY = 'sl.bot.usage.v1';
const BUDGET_KEY = 'sl.bot.budget.v1';
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKUPS_PER_CALL = 10;

interface NameEntry {
  name: string | null;
  at: number;
}

export async function handleBotSettingsGet(): Promise<BotSettings> {
  const stored = await getLocal<unknown>(SETTINGS_KEY, null);
  if (stored == null) return DEFAULT_BOT_SETTINGS;
  const parsed = botSettingsSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  // Saved by an older version with a different shape — start from the
  // defaults rather than run the bot on settings nobody chose.
  logger.warn('stored bot settings no longer match the schema — using defaults', 'bot');
  return DEFAULT_BOT_SETTINGS;
}

export async function handleBotSettingsSet(settings: BotSettings): Promise<BotSettings> {
  await setLocal(SETTINGS_KEY, settings);
  return settings;
}

/** Today's active time for the bot's hours-per-day limit (engine/sniper.ts). */
export async function handleBotUsageGet(): Promise<BotDailyUsage | null> {
  const parsed = botDailyUsageSchema.safeParse(await getLocal<unknown>(USAGE_KEY, null));
  return parsed.success ? parsed.data : null;
}

export async function handleBotUsageSet(usage: BotDailyUsage): Promise<{ ok: true }> {
  await setLocal(USAGE_KEY, usage);
  return { ok: true };
}

/** The bot's hourly budgets (engine/sniper.ts): its governor's state and
 * its search/buy windows. In `storage.local`, not `storage.session` like the
 * main governor's crash-recovery state: the windows are one hour long and
 * prune themselves, and a browser restart must not refill them either. A
 * stored value that no longer parses reads as none. */
export async function handleBotBudgetGet(): Promise<BotBudgetState | null> {
  const parsed = extBackgroundBotBudgetSetPayloadSchema.safeParse(await getLocal<unknown>(BUDGET_KEY, null));
  return parsed.success ? parsed.data : null;
}

export async function handleBotBudgetSet(budget: BotBudgetState): Promise<{ ok: true }> {
  await setLocal(BUDGET_KEY, budget);
  return { ok: true };
}

/** The saved catalog, re-validated on the way out against the same strict
 * schema `catalog.save` and content applied on the way in (an older build's
 * catalog, or an edited `storage.local`, reads as none). */
export async function handleCatalogGet(): Promise<Catalog | null> {
  const parsed = adapterCatalogSchema.safeParse(await getLocal<unknown>(CATALOG_KEY, null));
  return parsed.success ? (parsed.data as Catalog) : null;
}

/** The adapter sends the whole catalog at once, built from the web app's
 * own lists (model/catalog.ts). */
export async function handleCatalogSave(catalog: Catalog): Promise<{ ok: true }> {
  await setLocal(CATALOG_KEY, catalog);
  playerNames = null;
  return { ok: true };
}

let playerNames: Map<number, string> | null = null;

async function catalogName(id: number): Promise<string | null> {
  if (!playerNames) {
    const catalog = await handleCatalogGet();
    playerNames = new Map((catalog?.players ?? []).map((p) => [p.id, p.name]));
  }
  return playerNames.get(id) ?? null;
}

export async function handleCardNames(resourceIds: number[]): Promise<Record<string, string | null>> {
  const cache = await getLocal<Record<string, NameEntry>>(NAMES_KEY, {});
  const now = Date.now();
  const out: Record<string, string | null> = {};
  const missing: number[] = [];

  for (const id of new Set(resourceIds)) {
    const fromCatalog = await catalogName(id);
    if (fromCatalog) {
      out[id] = fromCatalog;
      continue;
    }
    const hit = cache[id];
    if (hit && (hit.name != null || now - hit.at < MISS_TTL_MS)) out[id] = hit.name;
    else missing.push(id);
  }

  if (missing.length > 0 && (await isAuthenticated())) {
    let changed = false;
    for (const id of missing.slice(0, MAX_LOOKUPS_PER_CALL)) {
      try {
        // GET /api/v1/market/cards/{resourceId}. Built as a variable: the API's
        // extension-api-contract test checks literal paths only, and cannot
        // match an interpolated id or a query string against the spec.
        const cardPath = `/api/v1/market/cards/${id}?window=24h`;
        const card = await apiJson<MarketCardHistoryResponse>(cardPath, {}, { retries: 0 });
        cache[id] = { name: card.name, at: now };
        out[id] = card.name;
        changed = true;
      } catch {
        // Unknown card or API unreachable: leave it out and try again later.
      }
    }
    if (changed) await setLocal(NAMES_KEY, cache);
  }

  return out;
}
