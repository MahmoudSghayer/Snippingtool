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
import { DEFAULT_BOT_SETTINGS, botSettingsSchema, type BotSettings, type MarketCardHistoryResponse } from '@sl/shared';

import { apiJson } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { getLocal, setLocal } from '../lib/storage.js';

import type { Catalog } from '../model/catalog.js';

const SETTINGS_KEY = 'sl.bot.settings.v1';
const NAMES_KEY = 'sl.cards.names.v1';
const CATALOG_KEY = 'sl.catalog.v1';
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

export async function handleCatalogGet(): Promise<Catalog | null> {
  return getLocal<Catalog | null>(CATALOG_KEY, null);
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
        const card = await apiJson<MarketCardHistoryResponse>(`/api/v1/market/cards/${id}?window=24h`, {}, { retries: 0 });
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
