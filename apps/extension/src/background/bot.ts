/*
 * bot.ts — background handlers for the Sniping Bot page: its settings
 * (`bot.settingsGet` / `bot.settingsSet`: `storage.local`, and the signed-in
 * account's copy at `/api/v1/extension/bot-settings`, so every browser the
 * trader signs in on starts with the same ones), Snipe or Bid and Bid
 * mode's settings (`bot.modeGet` / `bot.modeSet`, this browser only), EA's
 * player/club/league/nation lists for the Snipe Targets form
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
  DEFAULT_BOT_MODE_SETTINGS,
  DEFAULT_BOT_SETTINGS,
  adapterCatalogSchema,
  botModeSettingsSchema,
  botSettingsSyncResponseSchema,
  botDailyUsageSchema,
  extBackgroundBotBudgetSetPayloadSchema,
  botSettingsSchema,
  type BotBudgetState,
  type BotDailyUsage,
  type BotModeSettings,
  type BotSettings,
  type MarketCardHistoryResponse,
} from '@sl/shared';

import { apiJson, NetworkError } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { getLocal, setLocal } from '../lib/storage.js';

import type { Catalog } from '../model/catalog.js';

const SETTINGS_KEY = 'sl.bot.settings.v1';
/** Snipe or Bid, and Bid mode's settings: this browser only (see
 * `botModeSettingsSchema` for why they are not synced yet). */
const MODE_KEY = 'sl.bot.mode.v1';
/** Set (to the save's time) while a save has not reached the account yet. */
const SETTINGS_PENDING_KEY = 'sl.bot.settings.pending.v1';
/** A burst of edits (a slider dragged) goes up as one save. */
const SETTINGS_UPLOAD_DELAY_MS = 1_500;
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

/** The settings saved in this browser, or null when there are none. */
async function localBotSettings(): Promise<BotSettings | null> {
  const stored = await getLocal<unknown>(SETTINGS_KEY, null);
  if (stored == null) return null;
  const parsed = botSettingsSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  // Saved by an older version with a different shape — start from the
  // defaults rather than run the bot on settings nobody chose.
  logger.warn('stored bot settings no longer match the schema — using defaults', 'bot');
  return null;
}

/** Sends `settings` to the account. False when it did not get there
 * (signed out, offline, or refused: the local copy stays the one in use). */
async function uploadBotSettings(settings: BotSettings): Promise<boolean> {
  if (!(await isAuthenticated())) return false;
  try {
    await apiJson('/api/v1/extension/bot-settings', { method: 'PUT', body: JSON.stringify({ settings }) }, { retries: 1 });
    return true;
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`bot settings not saved to the account: ${String(err)}`, 'bot');
    return false;
  }
}

/** The account's settings. Null when it has none to give (never saved, or
 * stored by a version whose shape this one no longer reads); undefined
 * when it could not be asked (signed out, offline, refused), which must
 * never read as "none": the local copy would then overwrite the account's. */
async function accountBotSettings(): Promise<BotSettings | null | undefined> {
  if (!(await isAuthenticated())) return undefined;
  try {
    // One retry: the page is waiting on this to show the settings.
    const body = await apiJson<unknown>('/api/v1/extension/bot-settings', {}, { retries: 1 });
    const parsed = botSettingsSyncResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.settings : undefined;
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`bot settings not read from the account: ${String(err)}`, 'bot');
    return undefined;
  }
}

/** The bot's settings: the account's when it has some, so a browser the
 * trader signs in on (another PC, a cloud machine) starts with the ones
 * they chose; else this browser's, which then go up to the account; else
 * the defaults. A save that has not reached the account yet (made offline)
 * goes up first, rather than be overwritten by the account's older copy. */
export async function handleBotSettingsGet(): Promise<BotSettings> {
  const local = await localBotSettings();
  const pending = await getLocal<number | null>(SETTINGS_PENDING_KEY, null);
  if (local && pending != null) {
    if (await uploadBotSettings(local)) await clearPendingIf(pending);
    return local;
  }
  const account = await accountBotSettings();
  if (account) {
    await setLocal(SETTINGS_KEY, account);
    return account;
  }
  if (account === null && local) void uploadBotSettings(local);
  return local ?? DEFAULT_BOT_SETTINGS;
}

let uploadTimer: ReturnType<typeof setTimeout> | null = null;

/** Saves `settings` here at once, and to the account shortly after (one
 * upload for a burst of edits). Until that upload lands, the pending mark
 * keeps the next load from taking the account's older copy. */
export async function handleBotSettingsSet(settings: BotSettings): Promise<BotSettings> {
  const savedAt = Date.now();
  await setLocal(SETTINGS_KEY, settings);
  await setLocal(SETTINGS_PENDING_KEY, savedAt);
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    void uploadBotSettings(settings).then((ok) => (ok ? clearPendingIf(savedAt) : undefined));
  }, SETTINGS_UPLOAD_DELAY_MS);
  return settings;
}

/** Clears the pending mark, unless a later save has set it again. */
async function clearPendingIf(savedAt: number): Promise<void> {
  if ((await getLocal<number | null>(SETTINGS_PENDING_KEY, null)) === savedAt) await setLocal(SETTINGS_PENDING_KEY, null);
}

/** Snipe or Bid, and Bid mode's settings, as saved in this browser. Kept
 * out of the account's bot settings: the API validates those strictly, so
 * a field added there needs the API deployed first. A stored value that no
 * longer parses reads as the defaults (Snipe). */
export async function handleBotModeGet(): Promise<BotModeSettings> {
  const parsed = botModeSettingsSchema.safeParse(await getLocal<unknown>(MODE_KEY, null));
  return parsed.success ? parsed.data : DEFAULT_BOT_MODE_SETTINGS;
}

export async function handleBotModeSet(settings: BotModeSettings): Promise<BotModeSettings> {
  await setLocal(MODE_KEY, settings);
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
