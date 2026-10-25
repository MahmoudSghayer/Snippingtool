/*
 * bot.ts — background handlers for the Sniping Bot page: its settings
 * (`bot.settingsGet` / `bot.settingsSet`: `storage.local`, and the signed-in
 * account's copy at `/api/v1/extension/bot-settings`, so every browser the
 * trader signs in on starts with the same ones), Snipe or Bid and Bid
 * mode's settings (`bot.modeGet` / `bot.modeSet`, this browser only),
 * Gallery mode's list (`bot.galleryGet` / `bot.gallerySet`: `storage.local`,
 * and the account's copy at `/api/v1/extension/gallery`, so every browser
 * shows which Sets are done and which are not), EA's
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
  GALLERY_LIMITS,
  GALLERY_OWNED_BATCH_MAX,
  galleryOwnedResponseSchema,
  gallerySyncResponseSchema,
  galleryStateSchema,
  putGalleryResponseSchema,
  type BotBudgetState,
  type BotDailyUsage,
  type BotModeSettings,
  type BotSettings,
  type GalleryState,
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
/** Gallery mode's list and progress: this browser's copy of the account's. */
const GALLERY_KEY = 'sl.bot.gallery.v1';
/** Set (to the save's time) while a Gallery save has not reached the
 * account yet. */
const GALLERY_PENDING_KEY = 'sl.bot.gallery.pending.v1';
/** When the account's list this browser last read or saved was saved
 * there (its `updatedAt`): another browser has saved since when the
 * account's differs. */
const GALLERY_BASE_KEY = 'sl.bot.gallery.base.v1';
/** Set once this browser's list has been synced with the account the first
 * time, its completed Sets added to the account's (lists kept before sync
 * existed each hold their own). */
const GALLERY_SYNCED_KEY = 'sl.bot.gallery.synced.v1';
/** A running bot saves its list after every card step: at most one upload
 * this often, always the latest list, so steady saves never hold it back. */
const GALLERY_UPLOAD_EVERY_MS = 2_000;
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

/** Gallery mode's list as saved in this browser (null: none saved, or a
 * stored value that no longer parses). */
async function localGallery(): Promise<GalleryState | null> {
  const parsed = galleryStateSchema.safeParse(await getLocal<unknown>(GALLERY_KEY, null));
  return parsed.success ? parsed.data : null;
}

/** Sends `state` to the account. False when it did not get there (signed
 * out, offline, or refused: the local copy stays the one in use). */
async function uploadGallery(state: GalleryState): Promise<boolean> {
  if (!(await isAuthenticated())) return false;
  try {
    const body = await apiJson<unknown>('/api/v1/extension/gallery', { method: 'PUT', body: JSON.stringify({ state }) }, { retries: 1 });
    const saved = putGalleryResponseSchema.safeParse(body);
    if (saved.success) await setLocal(GALLERY_BASE_KEY, saved.data.updatedAt);
    return true;
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`Gallery list not saved to the account: ${String(err)}`, 'bot');
    return false;
  }
}

/** The account's list and when it was saved there (both null: it has
 * none, or one this version no longer reads); undefined when it could not
 * be asked (signed out, offline, refused), which must never read as
 * "none": the local copy would then overwrite the account's. */
async function accountGallery(): Promise<{ state: GalleryState | null; updatedAt: string | null } | undefined> {
  if (!(await isAuthenticated())) return undefined;
  try {
    // One retry: the page is waiting on this to show the list.
    const body = await apiJson<unknown>('/api/v1/extension/gallery', {}, { retries: 1 });
    const parsed = gallerySyncResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`Gallery list not read from the account: ${String(err)}`, 'bot');
    return undefined;
  }
}

/** Uploads go one after another, so an older list never lands after a
 * newer one; a list with a newer one queued behind it is not sent. */
let galleryUploads: Promise<unknown> = Promise.resolve();
let galleryQueued = 0;

/** Queues `state` for the account; once it is there, clears the pending
 * mark of the save at `savedAt` (unless a later save set it again). */
function queueGalleryUpload(state: GalleryState, savedAt: number | null): Promise<boolean> {
  const seq = ++galleryQueued;
  const run = galleryUploads.then(async () => {
    if (seq !== galleryQueued) return false;
    const ok = await uploadGallery(state);
    if (ok && savedAt != null) await clearGalleryPendingIf(savedAt);
    return ok;
  });
  galleryUploads = run.catch(() => undefined);
  return run;
}

/** `account` with the Sets `local` marked completed added, with when: a
 * Set this browser saw completed is never lost to a list saved elsewhere.
 * Past GALLERY_LIMITS.completed, the ones completed longest ago go (those
 * with no time first). `account` itself when there is nothing to add. */
function keepCompleted(account: GalleryState, local: GalleryState): GalleryState {
  const ids = [...(account.completed ?? [])];
  const at: Record<string, number> = { ...account.completedAt };
  for (const id of local.completed ?? []) {
    if (ids.includes(id)) continue;
    ids.push(id);
    const t = local.completedAt?.[String(id)];
    if (t !== undefined) at[String(id)] = t;
  }
  if (ids.length === (account.completed?.length ?? 0)) return account;
  let kept = ids;
  if (ids.length > GALLERY_LIMITS.completed) {
    const when = (id: number) => at[String(id)] ?? 0;
    const oldest = ids
      .map((id, i) => ({ id, i }))
      .sort((a, b) => when(a.id) - when(b.id) || a.i - b.i)
      .slice(0, ids.length - GALLERY_LIMITS.completed);
    const gone = new Set(oldest.map((x) => x.id));
    kept = ids.filter((id) => !gone.has(id));
  }
  const next: GalleryState = { ...account, completed: kept };
  const times = Object.entries(at).filter(([id]) => kept.includes(Number(id)));
  if (times.length > 0) next.completedAt = Object.fromEntries(times);
  else delete next.completedAt;
  return next;
}

/** Marks this browser's first sync done once `upload` (if any) lands. */
async function syncedOnce(upload: Promise<boolean> | null): Promise<void> {
  if (upload === null || (await upload)) await setLocal(GALLERY_SYNCED_KEY, true);
}

/** Takes `account` (as saved there at `updatedAt`) with this browser's
 * completed Sets added; uploads it when that added any. Resolves to the
 * merged list, and the upload, if any. */
async function takeAccountGallery(
  account: GalleryState,
  updatedAt: string | null,
  local: GalleryState,
  pending: number | null,
): Promise<{ state: GalleryState; upload: Promise<boolean> | null }> {
  const merged = keepCompleted(account, local);
  await setLocal(GALLERY_KEY, merged);
  await setLocal(GALLERY_BASE_KEY, updatedAt);
  if (merged === account) {
    if (pending != null) await clearGalleryPendingIf(pending);
    return { state: merged, upload: null };
  }
  return { state: merged, upload: queueGalleryUpload(merged, pending) };
}

/**
 * Gallery mode's list: the account's when it has one, so a browser the
 * trader signs in on (another PC, a cloud machine, after signing out and
 * back in) shows which Sets are done and which are not; else this
 * browser's, which then goes up to the account; else none.
 *  - A save that has not reached the account yet (made offline, or the
 *    browser closed first) goes up first, rather than be overwritten by the
 *    account's older copy: unless another browser saved the account's since
 *    this one last synced, and then the account's wins, keeping the Sets
 *    this browser marked completed.
 *  - The first time this browser syncs (`GALLERY_SYNCED_KEY` unset), the
 *    Sets its own list marked completed are added to the account's, so
 *    lists kept in several browsers before sync existed lose none. After
 *    that the account's list wins as it is: a Set undone (Undo) in another
 *    browser stays undone.
 * An account that cannot be asked leaves the local copy in use, and the
 * first sync still to do.
 */
export async function handleBotGalleryGet(): Promise<GalleryState | null> {
  const local = await localGallery();
  const pending = await getLocal<number | null>(GALLERY_PENDING_KEY, null);
  const account = await accountGallery();
  if (account === undefined) return local;
  const synced = (await getLocal<boolean | null>(GALLERY_SYNCED_KEY, null)) === true;
  if (local && pending != null) {
    const base = await getLocal<string | null>(GALLERY_BASE_KEY, null);
    if (!account.state || account.updatedAt === base) {
      // The account then holds this browser's completed Sets.
      await syncedOnce(queueGalleryUpload(local, pending));
      return local;
    }
    const taken = await takeAccountGallery(account.state, account.updatedAt, local, pending);
    await syncedOnce(taken.upload);
    return taken.state;
  }
  if (account.state) {
    if (local && !synced) {
      const taken = await takeAccountGallery(account.state, account.updatedAt, local, null);
      await syncedOnce(taken.upload);
      return taken.state;
    }
    await setLocal(GALLERY_KEY, account.state);
    await setLocal(GALLERY_BASE_KEY, account.updatedAt);
    if (!synced) await syncedOnce(null);
    return account.state;
  }
  if (local) void syncedOnce(queueGalleryUpload(local, null));
  else if (!synced) await syncedOnce(null);
  return local;
}

/** The account's collected-card catalogue (user_gallery_owned): every card id
 * put through the club in Gallery mode. A card counts for FC's Gallery once it
 * has passed through the club, so it stays collected after Nova lists it again
 * and it is sold, and on any browser. null when it could not be asked (signed
 * out, offline, refused) — the club check then stands alone. */
export async function handleBotGalleryOwnedGet(): Promise<number[] | null> {
  if (!(await isAuthenticated())) return null;
  try {
    const body = await apiJson<unknown>('/api/v1/extension/gallery/owned', {}, { retries: 1 });
    const parsed = galleryOwnedResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.resourceIds : null;
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`Gallery catalogue not read from the account: ${String(err)}`, 'bot');
    return null;
  }
}

/** Adds card ids the bot has just clubbed to the account's catalogue, in
 * batches the endpoint accepts. Idempotent server-side, so a lost answer is
 * harmless (the card is re-sent next time it is clubbed). */
export async function handleBotGalleryOwnedAdd(resourceIds: number[]): Promise<{ ok: boolean }> {
  if (resourceIds.length === 0 || !(await isAuthenticated())) return { ok: false };
  try {
    for (let i = 0; i < resourceIds.length; i += GALLERY_OWNED_BATCH_MAX) {
      const batch = resourceIds.slice(i, i + GALLERY_OWNED_BATCH_MAX);
      await apiJson<unknown>(
        '/api/v1/extension/gallery/owned',
        { method: 'POST', body: JSON.stringify({ resourceIds: batch }) },
        { retries: 1 },
      );
    }
    return { ok: true };
  } catch (err) {
    if (!(err instanceof NetworkError)) logger.warn(`Gallery catalogue not saved to the account: ${String(err)}`, 'bot');
    return { ok: false };
  }
}

let galleryTimer: ReturnType<typeof setTimeout> | null = null;
let galleryNext: { state: GalleryState; savedAt: number } | null = null;

/** Saves `state` here at once, and to the account within
 * GALLERY_UPLOAD_EVERY_MS (one upload for every save in that time, the
 * latest). Until that upload lands, the pending mark keeps the next load
 * from taking the account's older copy. */
export async function handleBotGallerySet(state: GalleryState): Promise<{ ok: true }> {
  const savedAt = Date.now();
  await setLocal(GALLERY_KEY, state);
  await setLocal(GALLERY_PENDING_KEY, savedAt);
  galleryNext = { state, savedAt };
  galleryTimer ??= setTimeout(() => {
    galleryTimer = null;
    const next = galleryNext;
    galleryNext = null;
    if (next) void queueGalleryUpload(next.state, next.savedAt);
  }, GALLERY_UPLOAD_EVERY_MS);
  return { ok: true };
}

/** Clears the Gallery pending mark, unless a later save has set it again. */
async function clearGalleryPendingIf(savedAt: number): Promise<void> {
  if ((await getLocal<number | null>(GALLERY_PENDING_KEY, null)) === savedAt) await setLocal(GALLERY_PENDING_KEY, null);
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
