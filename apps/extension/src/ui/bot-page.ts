/*
 * bot-page.ts — the Nova AI page: a full-height page over EA's content area,
 * opened from the "Nova AI" item this extension adds to EA's left
 * navigation (`ui/ea-nav.ts`).
 *
 * Left: the search Nova AI runs (built like EA's Transfer Market search),
 * the settings it runs on, and the Start bar. Right: the live session —
 * profit, searches, top snipes, the countdown to the next action, counters,
 * the activity log and search results.
 *
 * Start runs the bot on the search as it is filled in on this page: there is
 * no list of saved targets to add to. The search is handed to the bot through
 * `deps.setLiveSearch` and read by it before every search, so an edit while
 * running applies from the next one. It is never written to the user's
 * saved filters.
 *
 * Snipe or Bid, picked above Start (and locked while the bot runs): Bid
 * mode bids in auctions' last minutes up to the search's max price, so the
 * page says what the max price means there, shows the Bidding settings
 * while it is picked, and the open bids while it runs. Saved apart from the
 * other settings (`deps.saveModeSettings`, see `botModeSettingsSchema`).
 *
 * Risk: the settings start on the recommended limits and every number is
 * the user's to change within `BOT_LIMITS`. A risk meter (`botRiskLevel` in
 * @sl/shared) shows the level, the projected searches and buys a day, and
 * the reasons, live as the user edits. The first time the user saves
 * settings above low, the page holds them back until they tick
 * `RISK_ACKNOWLEDGMENT`, and stores `riskAcknowledgedAt`; after that it only
 * shows the level. "Reset to recommended" restores the defaults, and
 * "Short bursts" fills in fast short sessions with rests between them.
 *
 * Renders in its own closed shadow root: EA's styles cannot reach in, and
 * neither can page scripts (`host.shadowRoot` is null to them). Every
 * user-action handler ignores events a script made (`onTrusted`), so a page
 * script cannot change a limit, acknowledge the risk or press Start. All text
 * that comes from data (card names, error messages) goes through `esc()`.
 *
 * Look: EA FC web app styling, all through the `--ea-*` custom properties on
 * `.page`, so matching the live web app more closely is a token change.
 */
import {
  BOT_LIMITS,
  BOT_RISK_LABELS,
  DEFAULT_BOT_MODE_SETTINGS,
  EMPTY_GALLERY,
  GALLERY_LIMITS,
  MIN_SALE_PRICE,
  RECENT_SEARCHES_MAX,
  RISK_ACKNOWLEDGMENT,
  SEARCH_DELAY_PRESETS,
  botModeSettingsSchema,
  botRiskLevel,
  botSettingsSchema,
  computeTradeProfit,
  effectiveSearchPace,
  roundToPriceStep,
  stepPrice,
  withRecommendedLimits,
  withShortBurstLimits,
  GALLERY_GRADES,
  type BotMode,
  type BotModeSettings,
  type BotRiskLevel,
  type BotSettings,
  type FilterCriteria,
  type FutggLineup,
  type FutggSetSummary,
  type GalleryCard,
  type GalleryGrade,
  type GallerySet,
  type GalleryState,
} from '@sl/shared';

import {
  addFutggLineup,
  bestBuyableFutggTier,
  bestFutggTier,
  clearFinishedGallery,
  futggBestChoices,
  futggBuyableAlternative,
  futggClubIds,
  futggSbcCards,
  galleryCardNeeded,
  gallerySetBlockers,
  gallerySetProgress,
  gallerySummary,
  galleryUpgradable,
  markCompletedSets,
  parseGalleryList,
  removeFutggSet,
  setCompleted,
  type GallerySetBlocker,
  type GallerySetBlockerReason,
  type GalleryUpgrade,
} from '../engine/gallery.js';
import { TRANSFER_LIST_SIZE, type TransferListSummary } from '../lib/transfer-list.js';
import {
  SPECIAL_LEVEL,
  fold,
  portraitUrl,
  priceStep,
  raritiesForLevel,
  searchPlayers,
  type Catalog,
  type CatalogOption,
  type CatalogPlayer,
} from '../model/catalog.js';

import { NOVA_LOGO_SVG } from './brand.js';
import { readWallet } from './ea-wallet.js';
import { onTrusted } from './trusted-events.js';

import type { ActiveBid, Sniper, SniperLogEntry, SniperPhase, SniperSearchResult } from '../engine/sniper.js';

/** The search the bot runs: the one filled in on this page. */
export interface LiveSearch {
  id: string;
  name: string;
  filter: FilterCriteria;
}

export const LIVE_SEARCH_ID = 'live-search';

export interface BotPageDeps {
  /** The bot, once it can run; null while signed out or on a plan without it. */
  getSniper: () => Sniper | null;
  /** Why the bot cannot run, when `getSniper()` is null. */
  getUnavailableReason: () => string | null;
  /** Re-checks sign-in and plan (creating the bot if they now allow it).
   * Called whenever the page opens, so signing in from the account view
   * does not need a page reload. */
  prepare: () => Promise<void>;
  getSettings: () => BotSettings;
  saveSettings: (settings: BotSettings) => Promise<void>;
  /** Snipe or Bid, and Bid mode's settings (kept apart from `BotSettings`:
   * see `botModeSettingsSchema`). Omitted: Snipe, the defaults, not saved. */
  getModeSettings?: () => BotModeSettings;
  saveModeSettings?: (settings: BotModeSettings) => Promise<void>;
  /** Gallery mode's list, its cards' progress and its budget (this
   * browser's own, see @sl/shared `galleryStateSchema`). Omitted: an empty
   * list, not saved. */
  getGallery?: () => GalleryState;
  saveGallery?: (state: GalleryState) => Promise<void>;
  /** fut.gg's Gallery Sets, and one Set's cheapest lineup for a grade (null:
   * fut.gg could not be read). Omitted: no fut.gg picker. */
  futggSets?: () => Promise<FutggSetSummary[] | null>;
  futggLineup?: (setId: number, grade: GalleryGrade) => Promise<FutggLineup | null>;
  /** The account's collected-card catalogue (every card id ever clubbed), so
   * upgrading a Set reuses cards collected before and now sold. Null: the
   * catalogue could not be read. Omitted: not used. */
  galleryOwned?: () => Promise<readonly number[] | null>;
  /** The search the bot should run from now on (null: none). */
  setLiveSearch: (search: LiveSearch | null) => void;
  resolveNames: (resourceIds: number[]) => Promise<Record<string, string | null>>;
  /** EA's player/club/league/nation lists, if the web app has loaded them
   * since the extension was installed (model/catalog.ts). */
  getCatalog: () => Promise<Catalog | null>;
  /** Where the recent-searches log is kept between page loads (the
   * account's copy, content/recent-searches.ts). Read again each time the
   * page opens. Without it the log lasts until the page reloads. */
  recentSearches?: {
    load: () => Promise<unknown>;
    save: (list: RecentSearch[]) => Promise<void>;
  };
  /** The trader's transfer list as EA's page last showed it
   * (lib/transfer-list.ts): null until EA has loaded the whole list once.
   * Without it the Sold, Unsold and Transfer list figures stay empty. */
  getTransferList?: () => TransferListSummary | null;
  /** The Transfer list card's buttons (content/transfer-tools.ts): Clear
   * sold, and Relist unsold one price step lower, at the same prices or one
   * step higher. Each resolves with what happened, in the trader's words.
   * Without it the card has no buttons. */
  transferTools?: {
    clearSold: () => Promise<{ ok: boolean; message: string }>;
    relist: (step: -1 | 0 | 1, onProgress: (done: number, total: number) => void) => Promise<{ ok: boolean; message: string }>;
  };
  /** The coin balance EA's own responses last stated (a market, trade-pile
   * or buy answer), and when it arrived: EA's top bar is not always redrawn
   * after the bot's own buys and sales. */
  getCredits?: () => { credits: number; at: number } | null;
}

/** Where EA's content area is, in px from each window edge. */
export interface PageBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BotPage {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-render the live side (call when the sniper changes). */
  refresh(): void;
  /** Keep the page inside EA's content area: clear of its navigation and top bar. */
  setBounds(bounds: PageBounds): void;
  onOpenChange(cb: (open: boolean) => void): void;
}

// ---- the search form -------------------------------------------------------

export const OVR_MIN = 45;
export const OVR_MAX = 99;

export interface TargetForm {
  minOvr: number;
  maxOvr: number;
  player: CatalogPlayer | null;
  playerQuery: string;
  quality: string | null;
  rarity: number | null;
  position: string | null;
  chem: number | null;
  nation: number | null;
  league: number | null;
  club: number | null;
  minBuy: number | null;
  maxBuy: number | null;
}

export const blankForm = (): TargetForm => ({
  minOvr: OVR_MIN,
  maxOvr: OVR_MAX,
  player: null,
  playerQuery: '',
  quality: null,
  rarity: null,
  position: null,
  chem: null,
  nation: null,
  league: null,
  club: null,
  minBuy: null,
  maxBuy: null,
});

/** The search the form describes, or what is wrong with it. */
export function buildFilterFromForm(form: TargetForm): { filter: FilterCriteria } | { error: string } {
  const filter: FilterCriteria = {};
  if (form.player) filter.resourceId = form.player.id;
  else if (form.playerQuery.trim()) {
    const n = Number(form.playerQuery.trim());
    if (!Number.isInteger(n) || n <= 0) return { error: 'Pick a player from the list, or type their id' };
    filter.resourceId = n;
  }
  if (form.minOvr > OVR_MIN) filter.minRating = form.minOvr;
  if (form.maxOvr < OVR_MAX) filter.maxRating = form.maxOvr;
  if (form.quality)
    filter.quality = (form.quality === SPECIAL_LEVEL ? 'special' : form.quality) as FilterCriteria['quality'];
  if (form.rarity != null) filter.rarity = form.rarity;
  if (form.position) {
    // EA's position groups (Defenders, Midfielders, Attackers) search as a zone.
    if (/^\d+$/.test(form.position)) filter.zone = Number(form.position);
    else filter.position = form.position;
  }
  if (form.chem != null) filter.chemistryStyle = form.chem;
  if (form.nation != null) filter.nationality = form.nation;
  if (form.league != null) filter.league = form.league;
  if (form.club != null) filter.club = form.club;
  if (form.minBuy != null) filter.minPrice = form.minBuy;
  if (form.maxBuy != null) filter.maxPrice = form.maxBuy;

  if (Object.keys(filter).length === 0) return { error: 'Pick a player or at least one filter' };
  if (filter.minPrice != null && filter.maxPrice != null && filter.minPrice > filter.maxPrice) {
    return { error: 'Min price is above max price' };
  }
  return { filter };
}

/** A card sold at `sell`: EA's 5% tax, what the trader keeps, and the profit
 * over `buy` (null without a buy price). The same formula as every other
 * profit in the app (`computeTradeProfit`). */
export function saleProfit(sell: number, buy: number | null): { tax: number; net: number; profit: number | null } {
  const { eaTaxCoins, netProfit } = computeTradeProfit(buy ?? 0, sell);
  return { tax: eaTaxCoins, net: sell - eaTaxCoins, profit: buy == null ? null : netProfit };
}

// ---- recent searches -------------------------------------------------------
// Every search the user starts the bot on, newest first, so an earlier one
// is a click away. A log, not saved filters: nothing to name or manage.
// The account keeps it (@sl/shared `recentSearchSchema` is this shape).

export const MAX_RECENT_SEARCHES = RECENT_SEARCHES_MAX;

export interface RecentSearch {
  /** When the bot was started on it. */
  at: number;
  /** How the page described it then (EA's labels may not be loaded later). */
  name: string;
  form: TargetForm;
}

/** The same search, whatever order or time it was run at. */
function recentKey(form: TargetForm): string {
  const built = buildFilterFromForm(form);
  return 'filter' in built ? JSON.stringify(built.filter) : '';
}

/** `entry` at the top of `list`; an earlier run of the same search moves up
 * rather than appearing twice. */
export function addRecentSearch(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const key = recentKey(entry.form);
  return [entry, ...list.filter((r) => recentKey(r.form) !== key)].slice(0, MAX_RECENT_SEARCHES);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The form a stored entry describes, field by field: anything of the wrong
 * type is left blank, so a damaged entry can never break the page. */
function formFrom(raw: Record<string, unknown>): TargetForm {
  const form = blankForm();
  const num = (v: unknown) => (isNum(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 100) : null);
  if (isNum(raw.minOvr)) form.minOvr = Math.min(OVR_MAX, Math.max(OVR_MIN, raw.minOvr));
  if (isNum(raw.maxOvr)) form.maxOvr = Math.min(OVR_MAX, Math.max(OVR_MIN, raw.maxOvr));
  const p = raw.player as Record<string, unknown> | null | undefined;
  if (p && typeof p === 'object' && isNum(p.id) && typeof p.name === 'string')
    form.player = { id: p.id, name: p.name.slice(0, 100), rating: num(p.rating) };
  form.playerQuery = str(raw.playerQuery) ?? '';
  form.quality = str(raw.quality);
  form.position = str(raw.position);
  form.rarity = num(raw.rarity);
  form.chem = num(raw.chem);
  form.nation = num(raw.nation);
  form.league = num(raw.league);
  form.club = num(raw.club);
  form.minBuy = num(raw.minBuy);
  form.maxBuy = num(raw.maxBuy);
  return form;
}

/** What storage held, as recent searches: entries that are not one, or no
 * longer describe a search, are dropped. */
export function parseRecentSearches(raw: unknown): RecentSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSearch[] = [];
  for (const r of raw.slice(0, MAX_RECENT_SEARCHES) as unknown[]) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (!isNum(e.at) || typeof e.name !== 'string' || !e.form || typeof e.form !== 'object') continue;
    const form = formFrom(e.form as Record<string, unknown>);
    if (recentKey(form)) out.push({ at: e.at, name: e.name.slice(0, 200), form });
  }
  return out;
}

const COIN =`<svg class="coin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#f5c542"/><circle cx="8" cy="8" r="4.6" fill="none" stroke="#b8860b" stroke-width="1.4"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>`;
const STOP = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`;
/** EA's back arrow, beside its screen titles. */
const BACK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5 5 8l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When a fut.gg Set was marked completed, by the trader's own day, after a
 * space (" today", " yesterday", else " 20 Oct", with the year when it is
 * not this one). Empty when the list has no time for it: marked before
 * times were kept. */
function completedWhen(g: GalleryState, setId: number, now = Date.now()): string {
  const at = g.completedAt?.[String(setId)];
  if (at === undefined) return '';
  const day = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return ' today';
  if (day.toDateString() === yesterday.toDateString()) return ' yesterday';
  const year = day.getFullYear() === today.getFullYear() ? '' : ` ${day.getFullYear()}`;
  return ` ${day.getDate()} ${MONTHS[day.getMonth()]}${year}`;
}

/** The grade a completed fut.gg Set was completed at, or null when the list
 * kept none (a Set completed before completedGrade was kept). */
function completedGradeOf(g: GalleryState, setId: number): GalleryGrade | null {
  return g.completedGrade?.[String(setId)] ?? null;
}

/** One row of the virtualized fut.gg picker: its top offset and height (px,
 * matching the CSS) and its HTML. A category header or a Set row. */
interface PickerRow {
  top: number;
  h: number;
  html: string;
}
/** Row heights, in px — these MUST match the CSS (.g-cat, .g-set, .g-alt) so
 * the virtualizer places each row exactly where it renders. */
const PICKER_CAT_H = 28;
const PICKER_ROW_H = 34;
const PICKER_ALT_H = 40;
/** Extra px rendered above and below the scroll window, so a fast scroll does
 * not show blank space before the next frame fills it. */
const PICKER_OVERSCAN = 260;

const BLOCKER_PHRASE: Record<GallerySetBlockerReason, string> = {
  buy: 'still to buy',
  skipped: 'not listed on the market',
  sbc: 'SBC/Objective — collect it in the game',
  collecting: 'bought — on its way to your club',
};

/** Why an uncompleted Set is not done: a short summary for the row, and the
 * full per-card reason for the hover popup (its `title`). Null when nothing
 * is left to collect. */
function blockerNote(blockers: GallerySetBlocker[]): { summary: string; detail: string } | null {
  if (blockers.length === 0) return null;
  // Name the SBC/Objective card(s) in the summary when there are only a couple,
  // so the trader sees exactly which player is holding the Set up.
  const summary = blockers
    .map((b) =>
      b.reason === 'sbc' && b.cards.length <= 2
        ? `needs SBC: ${b.cards.map((c) => `${c.rating} ${c.name}`).join(', ')}`
        : `${b.cards.length} ${BLOCKER_PHRASE[b.reason]}`,
    )
    .join(', ');
  const detail = blockers
    .flatMap((b) =>
      b.cards.map(
        (c) => `${c.name} ${c.rating}${c.version ? ` ${c.version}` : ''} — ${BLOCKER_PHRASE[b.reason]}${c.guide !== undefined ? ` (~${fmt(c.guide)})` : ''}`,
      ),
    )
    .join('\n');
  return { summary, detail };
}

function rangeText(r: { min: number; max: number }): string {
  return r.min === r.max ? String(r.min) : `${r.min}-${r.max}`;
}

/** The pace the bot really searches at (`effectiveSearchPace`): the
 * delay's, or the hourly limit's when that is lower, and then how soon the
 * limit pauses it. */
function paceText(s: BotSettings): string {
  const p = effectiveSearchPace(s);
  if (!p.capped) return `About ${fmt(p.perHour)} searches an hour at this delay (your limit is ${fmt(p.capPerHour)}).`;
  return (
    `This delay would make about ${fmt(p.delayPerHour)} searches an hour, over your limit of ${fmt(p.capPerHour)}: ` +
    `Nova AI pauses after about ${fmt(Math.max(1, p.minutesToCap ?? 0))} minutes of searching each hour, so it searches about ${fmt(p.perHour)} times an hour.`
  );
}

/** "3", "2-4" or "2 - 4" -> a range; null when unparseable. */
function parseRange(text: string, integer: boolean): { min: number; max: number } | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] != null ? Number(m[2]) : a;
  if (integer && (!Number.isInteger(a) || !Number.isInteger(b))) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** On the transfer list figures until EA's page has loaded the whole list:
 * they are read from what it loads, never asked of EA. */
const TL_WAITING = 'Open your Transfer List in EA once and Nova AI will keep these up to date';
/** The Transfer list card's relist choices. */
const RELIST_CHOICES: readonly { step: -1 | 0 | 1; label: string; title: string }[] = [
  { step: -1, label: '−1 step', title: 'List every unsold card again one price step lower' },
  { step: 0, label: 'Same', title: "List every unsold card again at its last prices (EA's Re-list All)" },
  { step: 1, label: '+1 step', title: 'List every unsold card again one price step higher' },
];

/** What the "Short bursts" preset does (`withShortBurstLimits`). */
const SHORT_BURSTS_HINT =
  'fast 10-15 minute sessions (4-6 seconds between searches), each followed by a 10-20 minute rest, at most 450 searches an hour';

/** The Snipe / Bid choice beside Start: each mode in a few words. */
const MODES: { mode: BotMode; label: string; hint: string }[] = [
  { mode: 'snipe', label: 'Snipe', hint: 'Buy Now at or under your max price' },
  { mode: 'bid', label: 'Bid', hint: 'Bid in the last minutes, up to your max price' },
  { mode: 'gallery', label: 'Gallery', hint: 'Buy your Gallery list, send each card to your club, sell it again' },
];

/** Over the Gallery list: how to write it, and what Nova does with it. */
const GALLERY_HELP =
  'One card a line: the player\'s name and the card\'s rating ("Hugo Ekitiké 85"). When two versions share a rating, add the version after it ("Hugo Ekitiké 85 Signature"), named as in the Rarity list on the Search tab: only that version is bought. A line starting with # names the Set the cards under it belong to. Nova buys each card (for 1 minute only under its market price, then the cheapest one listed: it never skips a card for its price), sends it to your club, and lists it again one step over what it cost (from about 2,000 coins, where EA\'s 5% tax is more than a step, at the lowest price that brings back what it cost).';

/** Under the fut.gg Set picker. */
const FUTGG_HELP =
  "Sets and lineups come from fut.gg's Gallery: for each grade, the Sets that reach it and the cheapest lineup that does, by fut.gg's own solver and prices. Pick a grade, tick the Sets and add them: Nova checks your club first, skips the cards you own, and lets a player you own stand in for a lineup card when he scores at least as much and the Set still makes the grade. It buys the rest exactly as fut.gg lists them (the same version, holographic or not), sends each one to your club and sells it again. A Set whose cards are all collected is marked completed and not offered again (Undo puts it back). Finish it in the game: Gallery, the Set, Autocomplete, then Confirm Changes. fut.gg's prices move, so the cost is an estimate.";

const GALLERY_STATUS: Record<GalleryCard['status'], string> = {
  todo: 'To buy',
  bought: 'Bought',
  club: 'In club',
  listed: 'Listed',
  skipped: 'Skipped',
  owned: 'In your club',
  sbc: 'SBC/Objective',
};

/** Most rows the Gallery feed draws per group (To buy / On the way /
 * Skipped / Done): a list of many Sets can run to hundreds of cards, and
 * drawing them all made the feed slow to scroll and to redraw. The group
 * header still shows the true count; the rest are a "+N more" line. */
const GALLERY_FEED_GROUP_MAX = 60;

/** Under the Buy Now price in Bid mode: what the max price means there. */
const BID_MAX_HINT =
  "In Bid mode, Max is the most Nova AI bids for this player. When a card's Buy Now price is at or under it, Nova AI buys it with Buy Now instead.";

/** In the Auto-sell card: it covers both modes. */
const AUTO_SELL_MODES_HINT =
  'Applies in both modes: to cards bought with Buy Now and to auctions won in Bid mode. With auto-sell off, cards won in Bid mode are moved to your transfer list without a listing.';

/** Without a max price, Bid mode has no limit to bid up to. */
const BID_NEEDS_MAX = 'Set a Max price: in Bid mode it is the most Nova AI bids for a player';

const PHASE_LABEL: Record<SniperPhase, string> = {
  idle: 'Ready',
  searching: 'Searching',
  buying: 'Buying',
  bidding: 'Bidding',
  checking: 'Checking your bids',
  cooldown: 'Pausing after a buy',
  waiting: 'Next search',
  break: 'On a break',
  rest: 'Resting',
  blocked: 'Paused by your limits',
  backoff: 'Waiting for EA',
  stopped: 'Stopped',
};

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .page {
    /* EA FC web app styling, from EA's own stylesheet (web-app/css/all.css).
       EA's page declares the UltimateTeam font; this page is in that document. */
    --ea-font: UltimateTeam, sans-serif;
    --ea-bg: #202c3d;
    --ea-panel: #151d29;
    --ea-surface: #233144;
    --ea-surface-2: #151d29;
    --ea-control: #0e141b;
    --ea-control-hover: #151d29;
    --ea-line: #deded826;
    --ea-line-strong: #deded84d;
    --ea-text: #fcfcfc;
    --ea-text-2: #deded8;
    --ea-muted: #a6a6a1;
    --ea-disabled: #30312f;
    --ea-disabled-ink: #575753;
    --ea-accent: #0b96ff;
    --ea-primary: linear-gradient(135deg, #b1ffff 0, #f2fcfc 17%, #f1f0ff 65%, #e2d6ff 100%);
    --ea-primary-hover: linear-gradient(135deg, #b1ffffb3 0, #f2fcfcb3 17%, #f1f0ffb3 65%, #e2d6ffb3 100%);
    --ea-primary-active: linear-gradient(135deg, #b1ffff80 0, #f2fcfc80 17%, #f1f0ff80 65%, #e2d6ff80 100%);
    --ea-primary-ink: #151616;
    --ea-focus: #b1ffff;
    --ea-success: #07f468;
    --ea-toggle-off: #575753;
    --ea-warning: #f7b702;
    --ea-danger: #fd4821;
    --ea-danger-ink: #151616;
    --ea-coin: #f7b702;
    --ea-radius: 8px;
    --ea-radius-lg: 10px;

    /* EA's "Search the Transfer Market" screen: its navy title bar, the
       floating search panel and its slate rows, inputs and buttons. */
    --ea-nav: #1b2433;
    --ea-float: #1b2433;
    --ea-row: #26354b;
    --ea-row-hover: #2e3f59;
    --ea-input: #111821;
    --ea-input-line: #2b3648;
    --ea-btn: #222e40;
    --ea-btn-line: #34415a;
    --ea-mint: #b1ffff;

    position: fixed; top: var(--top, 0px); right: var(--right, 0px); bottom: var(--bottom, 0px); left: var(--left, 0px);
    z-index: 2147482000;
    display: flex; flex-direction: column; background: var(--ea-nav); color: var(--ea-text);
    font: 400 16px/1.4 var(--ea-font); font-variant-numeric: tabular-nums;
  }
  .page[hidden] { display: none; }
  .coin { width: 14px; height: 14px; vertical-align: -2px; margin-left: 4px; }
  .amt { white-space: nowrap; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--ea-focus); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; }

  /* header */
  .top { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: var(--ea-nav); }
  .logo { width: 28px; height: 28px; flex: none; }
  .logo svg { display: block; width: 100%; height: 100%; }
  .top h1 { margin: 0; font-size: 24px; font-weight: 500; }
  .ver { color: var(--ea-muted); font-size: 12px; }
  .chip { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--ea-control); color: var(--ea-text-2); }
  .chip.running { background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); }
  .chip.stopped { background: color-mix(in srgb, var(--ea-danger) 18%, transparent); color: var(--ea-danger); }
  .spacer { flex: 1; }
  .risk { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; }
  .risk.low, .lvl.low { background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); }
  .risk.moderate, .lvl.moderate { background: color-mix(in srgb, var(--ea-warning) 18%, transparent); color: var(--ea-warning); }
  .risk.high, .lvl.high { background: color-mix(in srgb, var(--ea-danger) 18%, transparent); color: var(--ea-danger); }
  .risk.very_high, .lvl.very_high { background: var(--ea-danger); color: var(--ea-danger-ink); }
  .saved { color: var(--ea-success); font-size: 13px; min-width: 60px; text-align: right; }
  .wallet { display: flex; align-items: center; gap: 8px; }
  .wallet[hidden], .wallet .bal[hidden] { display: none; }
  .wallet .bal { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 17px; font-weight: 500; white-space: nowrap; }
  .wallet .bal .coin { margin-left: 0; }
  .wallet .fp { padding: 1px 5px; border-radius: 4px; background: var(--ea-accent); color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .3px; }
  .close { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin-left: -8px; border: 0; background: none; color: var(--ea-text); padding: 0; border-radius: 50%; }
  .close svg { width: 20px; height: 20px; }
  .close:hover { background: var(--ea-btn); }
  .notice { margin: 12px 20px 0; padding: 10px 14px; border-radius: var(--ea-radius); background: color-mix(in srgb, var(--ea-warning) 14%, transparent); color: var(--ea-warning); }
  .notice[hidden] { display: none; }

  /* EA's pitch artwork behind the panels: navy into teal, with its light
     streaks. Static, so it costs nothing per frame. */
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(400px, 44%) 1fr; gap: 20px; padding: 20px 24px;
    background:
      linear-gradient(200deg, transparent 0 58%, rgba(205,255,245,.30) 58.4%, rgba(205,255,245,.06) 60.5%, transparent 61%),
      linear-gradient(203deg, transparent 0 70%, rgba(205,255,245,.16) 70.3%, transparent 72%),
      radial-gradient(70% 90% at 100% 100%, #6fe8c0 0%, #22b39f 30%, transparent 70%),
      radial-gradient(60% 70% at 0% 0%, #34408f 0%, transparent 70%),
      linear-gradient(120deg, #1d2f5a 0%, #183c5c 40%, #137c80 75%, #2cc4a4 100%); }

  /* left panel: EA's floating search panel, its tab row, the Reset/Start bar */
  .settings { position: relative; min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--ea-float);
    border-radius: 16px; box-shadow: 0 16px 40px rgba(0,0,0,.35); }
  .tabs { display: flex; justify-content: center; gap: 8px; padding: 16px 16px 6px; }
  .tab { min-width: 104px; padding: 9px 22px; border: 1px solid var(--ea-btn-line); border-radius: 6px; background: var(--ea-btn); color: var(--ea-text); font-size: 15px; }
  .tab:hover { background: var(--ea-row-hover); }
  .tab[aria-selected='true'] { border-color: var(--ea-mint); background: var(--ea-float); }
  .settings[data-tab='search'] #knobs, .settings[data-tab='settings'] #targets, .settings[data-tab='settings'] #recent { display: none; }
  /* Gallery mode: its list takes the search's place on the Search tab */
  .settings:not([data-mode='gallery']) #gallery, .settings[data-tab='settings'] #gallery,
  .settings[data-mode='gallery'] #targets, .settings[data-mode='gallery'] #recent { display: none; }
  .g-list { display: block; width: 100%; box-sizing: border-box; min-height: 170px; resize: vertical; padding: 10px 12px; border-radius: 4px;
    border: 1px solid var(--ea-input-line); background: var(--ea-input); color: var(--ea-text); font: inherit; font-size: 14px; line-height: 20px; }
  .g-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .g-problems { margin-top: 8px; color: var(--ea-warning); font-size: 13px; line-height: 18px; }
  .g-problems:empty { display: none; }
  .g-budget input { width: 100%; min-width: 0; height: 44px; padding: 0 12px; border-radius: 4px; border: 1px solid var(--ea-input-line); background: var(--ea-input); color: var(--ea-text); font: inherit; font-size: 16px; }
  .g-sum { margin-top: 8px; font-size: 13px; color: var(--ea-text-2); }
  .g-sonly { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ea-text-2); cursor: pointer; }
  /* The picker is virtualized (buildPickerRows / renderFutggWindow): the Set
     list can be hundreds of rows, so .g-sets scrolls a spacer sized to the
     whole list while the DOM only holds the rows in view, each .g-item placed
     at its row's offset. Row heights here MUST match PICKER_*_H in the code. */
  .g-sets { margin-top: 10px; max-height: 280px; overflow-y: auto; border: 1px solid var(--ea-line); border-radius: 4px; contain: layout paint; }
  .g-spacer { position: relative; width: 100%; }
  .g-item { position: absolute; left: 0; right: 0; }
  .g-set { display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center; gap: 8px; padding: 7px 10px; height: 34px; box-sizing: border-box; font-size: 13px; border-bottom: 1px solid var(--ea-line); cursor: pointer; }
  .g-set:last-child { border-bottom: 0; }
  .g-set:hover { background: var(--ea-row-hover); }
  .g-set.added { color: var(--ea-muted); cursor: default; }
  .g-set .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g-set .cat { margin-left: 6px; color: var(--ea-muted); font-size: 12px; }
  .g-set .gr { font-weight: 700; min-width: 14px; text-align: center; }
  .g-set .gr.gS { color: var(--ea-success); }
  .g-set .cost { white-space: nowrap; }
  .g-set .tok { color: var(--ea-muted); font-size: 12px; white-space: nowrap; }
  .g-mine { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .g-mineset { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .g-mineset-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .g-mineset-info { min-width: 0; }
  .g-sethead { font-size: 13px; padding: 2px 6px 8px; color: var(--ea-text-2); }
  .g-sethead.done { color: var(--ea-success); }
  .g-group { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--ea-muted); padding: 10px 6px 6px; }
  .g-more { font-size: 12px; color: var(--ea-muted); padding: 4px 6px 2px; }
  .g-grades { display: inline-flex; gap: 4px; }
  .g-grade { min-width: 34px; height: 32px; border-radius: 6px; border: 1px solid var(--ea-line); background: var(--ea-control); color: var(--ea-text); font-weight: 700; cursor: pointer; }
  .g-grade.on { border-color: var(--ea-mint, var(--ea-focus)); background: var(--ea-float); }
  .g-cat { height: 28px; box-sizing: border-box; display: flex; align-items: center; font-size: 12px; font-weight: 700; color: var(--ea-muted); padding: 0 10px; border-bottom: 1px solid var(--ea-line); background: var(--ea-surface-2); }
  .g-set.done { color: var(--ea-muted); cursor: default; }
  .g-check { color: var(--ea-success); width: 13px; text-align: center; }
  .g-link { border: 0; background: none; color: var(--ea-accent); padding: 0; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
  .g-link:disabled { color: var(--ea-disabled-ink); cursor: default; }
  .g-mineset.done b { color: var(--ea-success); }
  .g-mine-actions { display: inline-flex; gap: 6px; flex-shrink: 0; }
  .g-sethead .warn { color: var(--ea-warning); }
  .g-why { color: var(--ea-muted); cursor: help; text-decoration: underline dotted; text-underline-offset: 2px; }
  .g-alt { height: 40px; box-sizing: border-box; display: flex; flex-wrap: wrap; align-content: center; align-items: center; gap: 0 6px; padding: 4px 10px 4px 31px; font-size: 12px; line-height: 15px; color: var(--ea-muted); border-bottom: 1px solid var(--ea-line); overflow: hidden; }
  .g-upgrade { color: var(--ea-accent, var(--ea-muted)); font-size: 12px; padding-left: 2px; }
  .g-switch { color: var(--ea-muted); font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-left: 2px; }
  .g-switch-label { white-space: nowrap; }
  .g-switch .g-link { font-weight: 700; min-width: 16px; text-align: center; }
  .settings-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 24px 8px; scrollbar-width: thin; scrollbar-color: var(--ea-input-line) transparent; }
  .card { background: var(--ea-row); border-radius: 6px; margin-bottom: 10px; }
  .card > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; font-size: 17px; line-height: 20px; font-weight: 600; color: var(--ea-text); }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary .chev { margin-left: auto; color: var(--ea-muted); transition: transform .15s; }
  .card[open] > summary .chev { transform: rotate(180deg); }
  .card .inner { padding: 0 16px 16px; }
  .field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 12px 0; }
  .field + .field { border-top: 1px solid var(--ea-line); }
  .field .name { font-weight: 500; font-size: 16px; }
  .field .help { grid-column: 1; color: var(--ea-muted); font-size: 13px; }
  .field .control { grid-column: 2; grid-row: 1 / span 2; }
  .stepper { display: flex; align-items: center; gap: 4px; border: 1px solid var(--ea-line); border-radius: var(--ea-radius); padding: 3px; background: var(--ea-control); }
  .stepper button { width: 30px; height: 30px; border: 0; border-radius: 6px; background: none; color: var(--ea-text-2); font-size: 18px; line-height: 1; }
  .stepper button:hover { background: var(--ea-control-hover); color: var(--ea-text); }
  .stepper input { width: 64px; border: 0; background: none; color: var(--ea-text); text-align: right; font: inherit; font-size: 15px; font-weight: 500; }
  .stepper input.wide { width: 104px; }
  .stepper .unit { color: var(--ea-muted); font-size: 12px; min-width: 30px; padding-right: 4px; }
  .stepper input[aria-invalid='true'] { color: var(--ea-danger); }
  .stepper:has(input[aria-invalid='true']) { border-color: var(--ea-danger); }
  .presets { display: flex; gap: 8px; justify-content: flex-end; padding: 4px 0 8px; }
  .preset { border: 1px solid var(--ea-line); background: var(--ea-control); border-radius: var(--ea-radius); padding: 6px 10px; text-align: center; min-width: 64px; }
  .preset:hover { background: var(--ea-control-hover); }
  .preset b { display: block; font-size: 13px; }
  .preset small { display: inline-block; margin-top: 3px; padding: 0 6px; border-radius: 4px; font-size: 10px; font-weight: 500; letter-spacing: .3px; }
  .preset[aria-pressed='true'] { border-color: var(--ea-accent); background: color-mix(in srgb, var(--ea-accent) 12%, var(--ea-control)); }
  .tag-low { background: color-mix(in srgb, var(--ea-success) 20%, transparent); color: var(--ea-success); }
  .tag-moderate { background: color-mix(in srgb, var(--ea-warning) 20%, transparent); color: var(--ea-warning); }
  .tag-high, .tag-very_high { background: color-mix(in srgb, var(--ea-danger) 20%, transparent); color: var(--ea-danger); }
  .toggle { position: relative; width: 48px; height: 24px; border-radius: 24px; border: 0; padding: 0; background: var(--ea-toggle-off); flex: none; transition: background-color .3s; }
  .toggle::after { content: ''; position: absolute; top: 0; left: 0; width: 24px; height: 24px; border-radius: 50%; background: var(--ea-text);
    box-shadow: rgba(0,0,0,.5) 0 1px 4px; transition: left .3s; }
  .toggle[aria-checked='true'] { background: var(--ea-success); }
  .toggle[aria-checked='true']::after { left: 24px; }
  .badge-rec { padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); font-size: 12px; font-weight: 500; }
  .hint { color: var(--ea-muted); font-size: 12px; padding-top: 8px; }

  .riskbox { background: var(--ea-surface); border: 1px solid transparent; border-radius: var(--ea-radius-lg); margin-bottom: 12px; padding: 14px 16px; }
  .riskbox.moderate { border-color: color-mix(in srgb, var(--ea-warning) 60%, transparent); }
  .riskbox.high, .riskbox.very_high { border-color: color-mix(in srgb, var(--ea-danger) 70%, transparent); }
  .riskhead { display: flex; align-items: center; gap: 10px; }
  .riskhead b { font-size: 17px; display: flex; align-items: center; gap: 8px; }
  .riskhead .spacer { flex: 1; }
  .ghost, .riskhead button, .ackbox button { border: 1px solid var(--ea-btn-line); background: var(--ea-btn); border-radius: 6px; min-height: 32px; padding: 8px 16px; color: var(--ea-text); font-size: 14px; line-height: 16px; }
  .ghost:hover, .riskhead button:hover, .ackbox button:hover { background: var(--ea-row-hover); }
  .ghost:disabled { background: var(--ea-disabled); color: var(--ea-disabled-ink); }
  .lvl { padding: 3px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; }
  .riskbar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 12px 0 8px; }
  .riskbar i { height: 6px; border-radius: 3px; background: var(--ea-line); }
  .riskbar.low i:nth-child(-n+1) { background: var(--ea-success); }
  .riskbar.moderate i:nth-child(-n+2) { background: var(--ea-warning); }
  .riskbar.high i:nth-child(-n+3) { background: var(--ea-danger); }
  .riskbar.very_high i { background: var(--ea-danger); }
  #risk-proj { color: var(--ea-text-2); }
  .riskbox ul { margin: 8px 0 0; padding-left: 18px; color: var(--ea-warning); font-size: 13px; }
  .ackbox { margin-top: 12px; padding: 12px 14px; border-radius: var(--ea-radius); background: var(--ea-bg); border: 1px solid var(--ea-danger); }
  .ackbox[hidden] { display: none; }
  .ackbox p { margin: 0 0 8px; }
  .ackbox label { display: flex; gap: 10px; align-items: flex-start; margin: 10px 0; color: var(--ea-text); }
  .ackbox label input { margin-top: 3px; accent-color: var(--ea-danger); }
  .ackbox button.danger { border-color: var(--ea-danger); color: var(--ea-danger); }
  .ackbox button:disabled { opacity: .45; }

  /* search card: EA's Transfer Market search */
  .combo { position: relative; }
  .suggest { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5; max-height: 280px; overflow-y: auto;
    background: var(--ea-surface-2); border: 1px solid var(--ea-line); border-radius: var(--ea-radius); box-shadow: 0 12px 28px rgba(0,0,0,.5); }
  .suggest[hidden] { display: none; }
  .suggest button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 8px 12px; border: 0; background: none; text-align: left; color: var(--ea-text); }
  .suggest button:hover, .suggest button.active { background: var(--ea-control-hover); }
  .suggest .r, .picked .r { min-width: 26px; font-weight: 500; color: var(--ea-coin); }
  .picked { display: flex; align-items: center; gap: 10px; flex: 1; padding: 8px 0; }
  .picked b { flex: 1; color: var(--ea-text); font-weight: 500; }
  .picked button { border: 0; background: none; color: var(--ea-muted); padding: 4px 8px; border-radius: 6px; }
  .picked button:hover { color: var(--ea-text); background: var(--ea-control); }
  .lbl { color: var(--ea-text-2); font-size: 14px; font-weight: 500; margin: 4px 0 8px; }
  .range2 { position: relative; height: 26px; margin: 0 8px 10px; }
  .range2 .track { position: absolute; left: 0; right: 0; top: 11px; height: 4px; border-radius: 2px; background: var(--ea-input-line); }
  .range2 .track i { position: absolute; top: 0; bottom: 0; background: var(--ea-primary); border-radius: 2px; }
  .range2 input[type=range] { position: absolute; left: -8px; right: -8px; width: calc(100% + 16px); top: 0; height: 26px; margin: 0;
    background: none; pointer-events: none; -webkit-appearance: none; appearance: none; }
  .range2 input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 20px; height: 20px; border-radius: 50%;
    background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; }
  .range2 input[type=range]::-moz-range-thumb { pointer-events: auto; width: 20px; height: 20px; border-radius: 50%; background: #fff; border: 0; cursor: pointer; }
  .ovr-boxes { margin-bottom: 4px; }
  .ovr-boxes input, .price input { width: 100%; min-width: 0; height: 44px; padding: 0 12px; border-radius: 4px; border: 1px solid var(--ea-input-line); background: var(--ea-input); color: var(--ea-text); font: inherit; font-size: 16px; }
  .ovr-boxes input:focus, .price input:focus { outline: none; border-color: var(--ea-text); }
  .price input::placeholder { color: var(--ea-text-2); opacity: .8; }
  .ea-player { display: flex; align-items: center; gap: 10px; padding: 0 14px; margin-bottom: 10px; min-height: 48px; border-radius: 4px;
    border: 1px solid var(--ea-input-line); background: var(--ea-input); color: var(--ea-text); }
  .ea-player input { flex: 1; min-width: 0; padding: 12px 0; border: 0; background: none; color: var(--ea-text); font: inherit; font-size: 17px; outline: none; }
  .ea-player input::placeholder { color: var(--ea-text-2); }
  .ea-player:focus-within { border-color: var(--ea-text); }
  /* EA's dropdowns: two to a row, slate, bold label, white caret */
  .dd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 6px; }
  .dd { position: relative; min-width: 0; }
  .dd.open { z-index: 20; }
  .dd-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 14px; border-radius: 4px;
    border: 1px solid transparent; background: var(--ea-row); color: var(--ea-text); text-align: left; }
  .dd-row:hover { background: var(--ea-row-hover); }
  .dd.open .dd-row { border-color: var(--ea-text); border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .dd.set .dd-row { border-color: color-mix(in srgb, var(--ea-mint) 55%, transparent); }
  .dd-icon { width: 26px; flex: none; display: flex; justify-content: center; }
  .dd-label { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-label small { display: block; font-size: 11px; font-weight: 600; color: var(--ea-muted); }
  .dd-clear { padding: 4px 8px; color: var(--ea-muted); font-size: 14px; border-radius: 6px; }
  .dd-clear:hover { color: var(--ea-text); background: var(--ea-row-hover); }
  .dd-caret { font-size: 14px; color: var(--ea-text); }
  .dd-panel { position: absolute; left: 0; right: 0; top: 100%; border: 1px solid var(--ea-text); border-top: 0; border-radius: 0 0 4px 4px;
    background: var(--ea-surface-2); padding: 4px 0; box-shadow: 0 14px 30px rgba(0,0,0,.5); }
  .dd-opts { max-height: 280px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ea-line-strong) var(--ea-surface-2); }
  .dd-opt { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 48px; padding: 8px 14px; border: 0; border-radius: 0; background: none; color: var(--ea-text); text-align: left; font-size: 15px; }
  .dd-opt:hover { background: var(--ea-control-hover); }
  .dd-opt[aria-selected='true'] { background: color-mix(in srgb, var(--ea-accent) 22%, var(--ea-surface-2)); font-weight: 500; }
  .dd-opt:focus-visible { outline: none; background: var(--ea-control-hover); }
  .opt-img { flex: none; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .opt-img img { width: 100%; height: 100%; object-fit: contain; }
  .opt-img.noimg { border-radius: 4px; background: var(--ea-line); }
  .opt-img.noimg::after { content: attr(data-initials); font-size: 10px; font-weight: 500; color: var(--ea-text-2); }
  .img-level, .img-pos, .img-chem { width: 30px; height: 30px; }
  .img-card { width: 30px; height: 40px; }
  .img-flag { width: 36px; height: 24px; }
  .img-logo { width: 32px; height: 32px; }
  .dd-icon .opt-img { transform: scale(.8); }
  .dd.disabled .dd-row { opacity: .45; cursor: not-allowed; }
  .dd.disabled .dd-row:hover { background: var(--ea-control); }
  .sg-face { flex: none; width: 34px; height: 34px; border-radius: 50%; overflow: hidden; background: var(--ea-control); }
  .sg-face img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .dd-empty { color: var(--ea-muted); font-size: 13px; padding: 8px 14px; }
  /* EA's "Buy Now Price:" block: heading and Clear, then Min: and Max:
     side by side, each a box between a − and a + */
  .sec-h { display: flex; align-items: baseline; justify-content: space-between; margin: 18px 0 8px; font-size: 17px; font-weight: 600; }
  .sec-clear { border: 0; background: none; padding: 2px 4px; color: var(--ea-muted); font-size: 14px; }
  .sec-clear:hover { color: var(--ea-text); }
  .mm { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 48px; margin-bottom: 4px; }
  .mm-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .mm-k { font-size: 15px; font-weight: 500; color: var(--ea-text); }
  .price { display: grid; grid-template-columns: 30px minmax(0, 1fr) 30px; align-items: center; gap: 8px; }
  .price .step { height: 36px; padding: 0; border: 0; background: none; color: var(--ea-text); font-size: 26px; font-weight: 500; line-height: 1; border-radius: 4px; }
  .price .step[data-dir='-1'], .price .step[data-sell-step='-1'] { color: var(--ea-muted); }
  .price .step:hover { background: var(--ea-btn); color: var(--ea-text); }
  #ea-search .profit { color: var(--ea-text-2); font-size: 13px; line-height: 1.5; margin: 22px 0 0; }
  #ea-search .profit b { color: var(--ea-text); font-weight: 500; }
  #ea-search .profit b.pos { color: var(--ea-success); } #ea-search .profit b.neg { color: var(--ea-danger); }
  #ea-search .profit .muted { color: var(--ea-muted); }
  .search-hint { color: var(--ea-muted); font-size: 12px; margin: 14px 0 16px; }
  .recent { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; margin-bottom: 6px; border: 1px solid var(--ea-input-line);
    border-radius: 4px; background: var(--ea-input); color: var(--ea-text); text-align: left; }
  .recent:hover { background: var(--ea-row-hover); }
  .recent .rc-main { flex: 1; min-width: 0; }
  .recent .rc-name { display: block; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent .rc-when { display: block; color: var(--ea-muted); font-size: 12px; }
  .recent .rc-use { color: var(--ea-accent); font-size: 13px; font-weight: 500; }

  /* EA's Reset and Search pair, pinned to the bottom of the panel */
  .runbar { position: relative; z-index: 6; padding: 14px 16px 12px; background: var(--ea-float); box-shadow: 0 -10px 18px -12px rgba(0,0,0,.6); }
  .run-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .reset-search { min-height: 48px; border: 1px solid var(--ea-btn-line); border-radius: 6px; background: var(--ea-btn); color: var(--ea-text); font: 400 20px/20px var(--ea-font); padding: 12px 24px; }
  .reset-search:hover { background: var(--ea-row-hover); }
  .start { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 48px; border: 0; border-radius: 6px;
    background: var(--ea-primary); color: var(--ea-primary-ink); font: 400 20px/20px var(--ea-font); padding: 12px 24px; }
  .start svg { width: 16px; height: 16px; }
  .start:hover:not(:disabled) { background: var(--ea-primary-hover); }
  .start:active:not(:disabled) { background: var(--ea-primary-active); }
  .start.stop { background: var(--ea-danger); color: var(--ea-danger-ink); }
  .start.stop:hover:not(:disabled) { background: color-mix(in srgb, var(--ea-danger) 80%, var(--ea-bg)); }
  .start:disabled { background: #4f504c; color: #787873; }
  /* Snipe / Bid, above Reset and Start */
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
  .mode { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 12px; border: 1px solid var(--ea-btn-line); border-radius: 6px;
    background: var(--ea-btn); color: var(--ea-text); text-align: left; font-size: 15px; font-weight: 600; }
  .mode small { color: var(--ea-muted); font-size: 12px; font-weight: 400; }
  .mode:hover:not(:disabled) { background: var(--ea-row-hover); }
  .mode[aria-checked='true'] { border-color: var(--ea-mint); background: var(--ea-float); }
  .mode:disabled { opacity: .55; }
  .mode:disabled[aria-checked='true'] { opacity: 1; }
  .run-status { margin-top: 8px; min-height: 18px; color: var(--ea-muted); font-size: 13px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-status.bad { color: var(--ea-warning); }
  .run-status.wrap { white-space: normal; }
  .run-status.go { cursor: pointer; text-decoration: underline; }

  /* right column: the session */
  .live { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 12px; padding: 16px; overflow: hidden;
    background: color-mix(in srgb, var(--ea-float) 94%, transparent); border-radius: 16px; box-shadow: 0 16px 40px rgba(0,0,0,.35); }
  .live-head { display: flex; align-items: center; gap: 12px; }
  .live-head h2 { margin: 0; font-size: 18px; line-height: 20px; font-weight: 600; color: var(--ea-text); }
  .dash { display: grid; grid-template-columns: 1fr 0.9fr 1.3fr 1.2fr; grid-template-rows: auto auto; gap: 12px; }
  .tile { border-radius: var(--ea-radius-lg); padding: 14px; display: flex; flex-direction: column; justify-content: center; background: var(--ea-row); }
  .tile .v { font-size: 26px; font-weight: 500; display: flex; align-items: center; }
  .tile .k { font-size: 12px; color: var(--ea-muted); }
  .tile.profit .v { color: var(--ea-coin); }
  .tile.searches .v { color: var(--ea-accent); }
  .panelbox { background: var(--ea-row); border: 0; border-radius: var(--ea-radius-lg); padding: 12px 14px; }
  .top-snipes h3 { margin: 0 0 8px; font-size: 18px; line-height: 20px; font-weight: 500; color: var(--ea-muted); }
  .ts-row { display: flex; justify-content: space-between; color: var(--ea-text-2); font-size: 13px; padding: 2px 0; }
  .ts-row:first-of-type { color: var(--ea-text); font-size: 15px; font-weight: 500; }
  .counters { grid-row: span 2; display: grid; gap: 6px; }
  .counter { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-radius: var(--ea-radius); background: var(--ea-row); border-left: 3px solid; font-size: 15px; }
  .counter .n { font-size: 15px; font-weight: 500; }
  .c-green { border-left-color: var(--ea-success); } .c-red { border-left-color: var(--ea-danger); } .c-blue { border-left-color: var(--ea-accent); }
  .c-yellow { border-left-color: var(--ea-coin); } .c-orange { border-left-color: var(--ea-warning); }
  .ring-box { grid-column: span 2; display: flex; align-items: center; justify-content: center; position: relative; min-height: 150px; contain: layout paint; }
  .ring-wrap { display: contents; }
  .ring { position: relative; width: 130px; height: 130px; }
  .ring-track, .ring-fill { position: absolute; inset: 0; box-sizing: border-box; border-radius: 50%; border: 7px solid var(--ea-line); }
  .ring-fill { border-color: var(--ea-accent); will-change: transform; }
  .ring-half { position: absolute; inset: 0; }
  .ring-r, .ring-r .ring-fill { clip-path: inset(0 0 0 50%); }
  .ring-l, .ring-l .ring-fill { clip-path: inset(0 50% 0 0); }
  .ring-label { position: absolute; text-align: center; }
  .ring-label .t { font-size: 30px; font-weight: 500; }
  .ring-label .p { font-size: 12px; color: var(--ea-muted); }
  .elapsed { position: absolute; left: 14px; bottom: 10px; font-size: 12px; color: var(--ea-muted); }
  .elapsed b { display: block; color: var(--ea-text); font-size: 15px; }
  .tl .hd { display: flex; justify-content: space-between; color: var(--ea-text-2); font-size: 13px; }
  .tl .big { font-size: 18px; font-weight: 500; margin-top: 4px; }
  .tl .of { font-size: 12px; font-weight: 600; }
  .tl .sub { min-height: 17px; margin-top: 6px; color: var(--ea-muted); font-size: 12px; }
  .tl .hd { align-items: center; }
  .tl-btn { border: 1px solid var(--ea-btn-line); background: var(--ea-btn); border-radius: 5px; padding: 2px 8px; color: var(--ea-text); font-size: 11px; line-height: 14px; white-space: nowrap; cursor: pointer; }
  .tl-btn:hover:not(:disabled) { background: var(--ea-row-hover); }
  .tl-btn:disabled { background: var(--ea-disabled); color: var(--ea-disabled-ink); cursor: default; }
  .tl .relist { margin-top: 8px; color: var(--ea-text-2); font-size: 12px; }
  .tl .relist .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; }
  .tl .relist .tl-btn { padding: 3px 4px; }
  .tl .msg { min-height: 15px; margin-top: 4px; color: var(--ea-muted); font-size: 11px; }
  .tl .msg.bad { color: var(--ea-danger); }
  .bar { height: 6px; border-radius: 3px; background: var(--ea-line); margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--ea-success); }

  .feeds { min-height: 0; display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; }
  .feed { min-height: 0; display: flex; flex-direction: column; background: var(--ea-panel); border-radius: var(--ea-radius-lg); overflow: hidden; }
  .feed h3 { margin: 0; padding: 12px 16px; font-size: 18px; line-height: 20px; font-weight: 500; color: var(--ea-muted); border-bottom: 1px solid var(--ea-line); }
  /* contain: a feed can hold hundreds of rows; keeping its scroll's repaint
     to itself stops the panel's layered background being redrawn each frame. */
  .feed .list { flex: 1; overflow-y: auto; padding: 8px; contain: layout paint; }
  /* content-visibility: the log keeps up to 200 rows; skip the off-screen
     ones so scrolling repaints only what is visible (as the bids/gallery
     rows already do). */
  .log { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 6px; border-radius: var(--ea-radius); background: var(--ea-surface); border-left: 3px solid var(--ea-line-strong); content-visibility: auto; contain-intrinsic-size: auto 44px; }
  .log.bought { border-left-color: var(--ea-success); } .log.failed { border-left-color: var(--ea-danger); } .log.blocked { border-left-color: var(--ea-warning); } .log.listed { border-left-color: var(--ea-accent); }
  .log.won { border-left-color: var(--ea-success); } .log.bid, .log.moved { border-left-color: var(--ea-accent); } .log.dropped { border-left-color: var(--ea-warning); }
  .log .main { flex: 1; min-width: 0; }
  .log .main b { font-weight: 500; }
  .log .sub { color: var(--ea-muted); font-size: 12px; }
  .pill { padding: 5px 10px; border-radius: var(--ea-radius); font-weight: 500; background: color-mix(in srgb, var(--ea-success) 16%, transparent); color: var(--ea-success); white-space: nowrap; }
  .pill.neg { background: color-mix(in srgb, var(--ea-danger) 16%, transparent); color: var(--ea-danger); }
  .res { font-size: 13px; padding: 3px 6px; color: var(--ea-text-2); content-visibility: auto; contain-intrinsic-size: auto 24px; }
  .res .when { color: var(--ea-muted); margin-right: 8px; }
  .res.item { display: flex; justify-content: space-between; color: var(--ea-text); background: var(--ea-surface); border-radius: 6px; margin: 2px 0; }
  .feeds.bids-open { grid-template-columns: 1fr 1.3fr; }
  .feed-tabs { display: flex; gap: 8px; padding: 0 8px; border-bottom: 1px solid var(--ea-line); }
  .ftab { padding: 12px 8px 10px; font: inherit; font-size: 18px; line-height: 20px; font-weight: 500; color: var(--ea-muted); background: none; border: 0; border-bottom: 2px solid transparent; cursor: pointer; }
  .ftab[aria-selected="true"] { color: var(--ea-text); border-bottom-color: var(--ea-accent); }
  .ftab .count { margin-left: 6px; font-size: 13px; color: var(--ea-text-2); }
  .feed .list[hidden] { display: none; }
  .bids-head { font-size: 13px; padding: 4px 6px 8px; color: var(--ea-text-2); }
  .bids-head .when { color: var(--ea-muted); }
  /* content-visibility: the Gallery feed and the bids list can run to many
     rows; skip the off-screen ones so the feed scrolls by what is visible. */
  .bidrow { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 6px; border-radius: var(--ea-radius); background: var(--ea-surface); border-left: 3px solid var(--ea-line-strong); content-visibility: auto; contain-intrinsic-size: auto 56px; }
  .bidrow.leading { border-left-color: var(--ea-success); } .bidrow.outbid { border-left-color: var(--ea-danger); } .bidrow.pending { border-left-color: var(--ea-warning); }
  .bidrow .main { flex: 1; min-width: 0; }
  .bidrow .main b { font-weight: 500; }
  .bidrow .sub { color: var(--ea-muted); font-size: 12px; }
  .st { margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .st.leading { background: color-mix(in srgb, var(--ea-success) 16%, transparent); color: var(--ea-success); }
  .st.outbid { background: color-mix(in srgb, var(--ea-danger) 16%, transparent); color: var(--ea-danger); }
  .st.pending { background: color-mix(in srgb, var(--ea-warning) 16%, transparent); color: var(--ea-warning); }
  .bidrow.listed { border-left-color: var(--ea-success); } .bidrow.skipped { border-left-color: var(--ea-danger); }
  .bidrow.bought, .bidrow.club, .bidrow.buying { border-left-color: var(--ea-warning); }
  .st.listed { background: color-mix(in srgb, var(--ea-success) 16%, transparent); color: var(--ea-success); }
  .st.skipped { background: color-mix(in srgb, var(--ea-danger) 16%, transparent); color: var(--ea-danger); }
  .st.bought, .st.club, .st.buying { background: color-mix(in srgb, var(--ea-warning) 16%, transparent); color: var(--ea-warning); }
  .st.todo { background: var(--ea-control); color: var(--ea-muted); }
  .bidrow .cur, .bidrow .left { display: flex; flex-direction: column; align-items: flex-end; white-space: nowrap; }
  .bidrow .left { min-width: 44px; }
  .bidrow .k { font-size: 11px; color: var(--ea-muted); }
  .bidrow .v { font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .bidrow.leading .cur .v { color: var(--ea-success); }
  .left.soon .v { color: var(--ea-warning); } .left.now .v { color: var(--ea-danger); }
  .empty { color: var(--ea-muted); padding: 18px; text-align: center; }
  .na { color: var(--ea-muted); }

  @media (max-width: 1100px) {
    .body { grid-template-columns: 1fr; overflow-y: auto; }
    .settings { overflow: visible; min-height: auto; }
    .settings-scroll { overflow: visible; flex: none; }
    .runbar { position: sticky; bottom: -20px; padding-bottom: 32px; border-radius: 0 0 16px 16px; }
    .live { overflow: visible; min-height: auto; }
    .dash { grid-template-columns: 1fr 1fr; }
    .counters, .ring-box { grid-column: span 2; grid-row: auto; }
    .feeds { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

export function createBotPage(deps: BotPageDeps, doc: Document = document): BotPage {
  const host = doc.createElement('div');
  host.id = 'ledger-bot-page';
  // Closed: the only reference is this closure's.
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const page = doc.createElement('div');
  page.className = 'page';
  page.hidden = true;
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Nova AI');
  root.append(style, page);
  (doc.body || doc.documentElement).appendChild(host);

  const names = new Map<number, string | null>();
  const openListeners = new Set<(open: boolean) => void>();
  let settings = deps.getSettings();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Snipe or Bid, and Bid mode's settings: saved apart from `settings`. */
  let modeSettings = deps.getModeSettings?.() ?? DEFAULT_BOT_MODE_SETTINGS;
  let modeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const bidMode = (): boolean => modeSettings.mode === 'bid';
  const galleryMode = (): boolean => modeSettings.mode === 'gallery';
  /** The Gallery list as typed (kept across re-renders) and what the last
   * Load said about it. */
  let galleryDraft: string | null = null;
  let galleryProblems: string[] = [];
  /** The fut.gg picker: its Sets once loaded (null: not yet), the ones
   * ticked, whether only grade S Sets show, and what the last add said. */
  let futggSets: FutggSetSummary[] | null = null;
  let futggBusy: 'sets' | 'add' | null = null;
  /** Ticked Sets, each with the grade whose lineup it is added for (its
   * best). */
  const futggPicked = new Map<number, GalleryGrade>();
  let futggProblems: string[] = [];
  /** The fut.gg picker is virtualized: its rows are built once as a flat list
   * (each with its y-offset, height and HTML), and only the rows inside the
   * scroll window are put in the DOM, so a list of hundreds scrolls smoothly.
   * `futggScroll` keeps the scroll position across the list's redraws. */
  let futggItemsCache: { items: PickerRow[]; total: number } | null = null;
  let futggScroll = 0;
  let ringFrame: number | null = null;
  let refreshQueued = false;
  let catalog: Catalog | null = null;
  let catalogPoll: ReturnType<typeof setInterval> | null = null;
  let livePoll: ReturnType<typeof setInterval> | null = null;

  /** Takes the latest catalog; re-renders only when it changed, and never
   * while a list is open (the user may be scrolling it). */
  function loadCatalog(): void {
    void deps.getCatalog().then((c) => {
      if (!c || page.hidden || c.capturedAt === catalog?.capturedAt || openDd) return;
      catalog = c;
      renderTargets();
    });
  }

  // Laid out like EA's own "Search the Transfer Market" screen: a back
  // arrow and title over the pitch artwork, the search on a floating panel
  // with EA's tab row, dropdown grid and price rows, and Reset beside the
  // gradient button at the bottom.
  page.innerHTML = `
    <div class="top">
      <button class="close" id="close" type="button" aria-label="Close Nova AI" title="Back to the web app">${BACK}</button>
      <span class="logo">${NOVA_LOGO_SVG}</span>
      <h1>Nova AI</h1>
      <span class="ver" title="Nova Trade version">v${esc(import.meta.env.VITE_EXTENSION_VERSION)}</span>
      <span class="chip" id="phase">Ready</span>
      <span class="risk" id="risk"></span>
      <span class="spacer"></span>
      <span class="saved" id="saved" aria-live="polite"></span>
      <span class="wallet" id="wallet" hidden>
        <span class="bal" id="w-coins" title="Your coins"><span class="amt"></span>${COIN}</span>
        <span class="bal" id="w-points" title="Your FC Points"><span class="amt"></span><span class="fp" aria-hidden="true">FP</span></span>
      </span>
    </div>
    <div class="notice" id="notice" hidden></div>
    <div class="body">
      <div class="settings" id="settings" data-tab="search">
        <div class="tabs" role="tablist" aria-label="Nova AI">
          <button type="button" class="tab" role="tab" data-tab="search" aria-selected="true">Search</button>
          <button type="button" class="tab" role="tab" data-tab="settings" aria-selected="false">Settings</button>
        </div>
        <div class="settings-scroll"><div id="targets"></div><div id="recent"></div><div id="gallery"></div><div id="knobs"></div></div>
        <div class="runbar">
          <div class="modes" id="modes" role="radiogroup" aria-label="What Nova AI does"></div>
          <div class="run-actions">
            <button class="reset-search" id="nf-reset" type="button">Reset</button>
            <button class="start" id="start" type="button">${PLAY}<span>Start</span></button>
          </div>
          <div class="run-status" id="run-status" aria-live="polite"></div>
        </div>
      </div>
      <div class="live">
        <div class="live-head"><h2>This session</h2><span class="spacer"></span>
          <button class="ghost" id="reset" type="button">Reset stats</button></div>
        <div class="dash" id="dash"></div>
        <div class="feeds">
          <section class="feed" aria-label="Nova AI activity"><h3>Activity</h3><div class="list" id="log"></div></section>
          <section class="feed" aria-label="Search results and active bids">
            <div class="feed-tabs" role="tablist" aria-label="Search results and active bids">
              <button type="button" class="ftab" role="tab" data-feed="results" aria-selected="true">Search results</button>
              <button type="button" class="ftab" role="tab" data-feed="bids" aria-selected="false">Active bids<span class="count" id="bids-count"></span></button>
              <button type="button" class="ftab" role="tab" data-feed="gallery" aria-selected="false" hidden>Gallery<span class="count" id="gallery-count"></span></button>
            </div>
            <div class="list" id="results"></div>
            <div class="list" id="bids" hidden></div>
            <div class="list" id="gallery-feed" hidden></div>
          </section>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => root.getElementById(id) as T;

  // ---- settings column ----------------------------------------------------

  function stepper(id: string, value: string, unit: string, label: string, wide = false): string {
    return `<div class="stepper control"><button type="button" data-step="${id}" data-dir="-1" aria-label="Less">−</button>
      <input id="${id}" value="${esc(value)}" inputmode="decimal" class="${wide ? 'wide' : ''}" aria-label="${esc(label)}" />
      <span class="unit">${esc(unit)}</span>
      <button type="button" data-step="${id}" data-dir="1" aria-label="More">+</button></div>`;
  }

  function field(name: string, help: string, control: string): string {
    return `<div class="field"><span class="name">${esc(name)}</span><span class="help">${esc(help)}</span>${control}</div>`;
  }

  function toggle(id: string, on: boolean, label: string): string {
    return `<button class="toggle" type="button" role="switch" id="${id}" aria-checked="${on}" aria-label="${esc(label)}"></button>`;
  }

  function section(title: string, body: string, extra = '', open = true): string {
    return `<details class="card" ${open ? 'open' : ''}><summary>${esc(title)}${extra}<span class="chev">⌄</span></summary><div class="inner">${body}</div></details>`;
  }

  function renderSettings(): void {
    renderTargets();
    renderRecent();
    renderGallery();
    renderKnobs();
  }

  // ---- Gallery mode -------------------------------------------------------

  /** The list as the running bot has it, else as saved. */
  function currentGallery(): GalleryState {
    return deps.getGallery?.() ?? EMPTY_GALLERY;
  }

  /** The list back as text: what the box shows until the trader edits it. */
  function galleryText(g: GalleryState): string {
    const lines: string[] = [];
    let set: string | undefined;
    // fut.gg's cards are listed under their Sets, not in the box.
    for (const c of g.cards.filter((x) => !x.exact)) {
      if (c.set !== set) {
        set = c.set;
        lines.push(set ? `# ${set}` : '#');
      }
      lines.push(`${c.name} ${c.rating}${c.version ? ` ${c.version}` : ''}`);
    }
    return lines.join('\n');
  }

  function gallerySumText(g: GalleryState): string {
    const n = gallerySummary(g);
    const owned = n.owned > 0 ? ` · ${n.owned} in your club` : '';
    const parked = n.parked > 0 ? ` · ${n.parked} left out (Set completed)` : '';
    return `${n.todo} to buy${owned} · ${n.listed} listed · ${n.bought + n.club} on the way · ${n.skipped} skipped${parked} · spent ${fmt(g.spent)} of ${fmt(g.budget)}`;
  }

  /** The Search tab in Gallery mode: the list box, its buttons, the budget. */
  function renderGallery(): void {
    const el = root.getElementById('gallery');
    if (!el) return;
    const g = currentGallery();
    const running = deps.getSniper()?.isRunning() ?? false;
    const off = running ? ' disabled' : '';
    if (galleryDraft == null) galleryDraft = galleryText(g);
    // Redrawn on every change: the Set list keeps where it was scrolled to
    // (mountFutggList restores it, since the virtualized list needs its spacer
    // sized before the scroll position can be set).
    futggScroll = (el.querySelector('.g-sets') as HTMLElement | null)?.scrollTop ?? futggScroll;
    el.innerHTML =
      (deps.futggSets ? section('fut.gg Sets', futggHtml(g, off)) : '') +
      section(
        'Gallery list',
        `<textarea class="g-list" id="g-list" spellcheck="false" aria-label="Gallery list"${off}
          placeholder="# Set name&#10;Hugo Ekitiké 85&#10;Florian Wirtz 86">${esc(galleryDraft)}</textarea>
        <div class="g-actions">
          <button type="button" class="preset" id="g-load"${off}><b>Load list</b></button>
          <button type="button" class="ghost" id="g-retry"${off}>Retry skipped</button>
          <button type="button" class="ghost" id="g-clear"${off}>Clear list</button>
        </div>
        <div class="g-problems" id="g-problems">${galleryProblems.map(esc).join('<br>')}</div>
        <div class="hint">${esc(GALLERY_HELP)}</div>`,
      ) +
      section(
        'Gallery budget',
        `${field(
          'Budget',
          "The most this list's buys may spend, in coins. Sales do not add back to it.",
          `<div class="g-budget control"><input id="g-budget" inputmode="numeric" value="${esc(fmt(g.budget))}" aria-label="Gallery budget"${off} /></div>`,
        )}
        <div class="g-sum" id="g-sum">${esc(gallerySumText(g))}</div>
        <div class="g-actions"><button type="button" class="ghost" id="g-reset-spent"${off}>Reset spent</button></div>`,
      );
    mountFutggList();
  }

  /** The Add button's count, as Sets are ticked (no redraw). */
  function futggAddLabel(): string {
    return futggBusy === 'add' ? 'Adding…' : `Add ${futggPicked.size === 1 ? '1 Set' : `${futggPicked.size} Sets`}`;
  }

  /** fut.gg's Sets for the grade picked, by category, ticked and added,
   * and the Sets on the list. */
  function futggHtml(g: GalleryState, off: string): string {
    const completed = new Set(g.completed ?? []);
    const busy = futggBusy !== null ? ' disabled' : '';
    const head = `<div class="g-actions">
        <button type="button" class="preset" id="g-futgg"${off}${busy}><b>${futggBusy === 'sets' ? 'Loading…' : futggSets ? 'Reload fut.gg Sets' : 'Browse fut.gg Sets'}</b></button>
      </div>`;
    let list = '';
    if (futggSets) {
      // The picker is virtualized: build every row once (futggItemsCache), but
      // the DOM only ever holds the rows in view (mountFutggList fills a spacer
      // sized to the whole list). This keeps a list of hundreds smooth to scroll.
      futggItemsCache = buildPickerRows(g, off, busy);
      list =
        futggItemsCache.items.length === 0
          ? `<div class="hint">fut.gg lists no Set with a lineup to buy right now.</div>`
          : `<div class="g-sets" role="group" aria-label="fut.gg Sets, each at its best grade"><div class="g-spacer" style="height:${futggItemsCache.total}px"></div></div>
            <div class="g-actions"><button type="button" class="preset" id="g-add"${off}${busy}${futggPicked.size === 0 ? ' disabled' : ''}><b>${futggAddLabel()}</b></button></div>`;
    } else {
      futggItemsCache = null;
    }
    const progress = gallerySetProgress(g);
    const mine =
      progress.length === 0
        ? ''
        : `<div class="g-mine">${progress
            .map((p) => {
              const isDone = completed.has(p.set.id);
              const mark = isDone
                ? `<button type="button" class="ghost" data-uncomplete="${p.set.id}"${off}>Completed${completedWhen(g, p.set.id)} ✓ · Undo</button>`
                : `<button type="button" class="ghost" data-complete="${p.set.id}"${off}>Mark completed</button>`;
              const blockers = isDone ? [] : gallerySetBlockers(g, p.set.id);
              const note = isDone ? null : blockerNote(blockers);
              const why = note ? ` · <span class="g-why" title="${esc(note.detail)}">not done: ${esc(note.summary)}</span>` : '';
              // Let the trader re-plan a Set at any other grade fut.gg has a
              // lineup for — a higher tier when one is available, or a lower,
              // cheaper one. (Nova also drops a stuck Set to a buyable tier on
              // its own mid-run; this is the manual control.) Highest first.
              const setSummary = futggSets?.find((x) => x.id === p.set.id);
              const curIdx = GALLERY_GRADES.indexOf(p.set.grade);
              const others =
                !isDone && setSummary
                  ? setSummary.tiers
                      .filter((t) => t.cards > 0 && GALLERY_GRADES.indexOf(t.grade) !== curIdx)
                      .sort((a, b) => GALLERY_GRADES.indexOf(b.grade) - GALLERY_GRADES.indexOf(a.grade))
                  : [];
              // The cost/buyable note goes in the button's title — plain text
              // only (COIN is an inline SVG, which would break the attribute).
              const switchBtns = others.length
                ? `<div class="g-switch"><span class="g-switch-label">switch tier:</span> ${others
                    .map(
                      (t) =>
                        `<button type="button" class="g-link" data-switch-grade="${p.set.id}:${t.grade}"${off}${busy} title="re-plan ${esc(p.set.name)} at grade ${t.grade} — fut.gg ${fmt(t.cost)} coins${(t.sbc ?? 0) === 0 ? ', all on the market' : `, needs ${t.sbc} SBC/Objective`}">${t.grade}</button>`,
                    )
                    .join(' ')}</div>`
                : '';
              // Added at a buyable grade because the best grade needs an
              // SBC/Objective card: a standing note of the higher grade and the
              // card(s) to complete in the game to reach it (the switch-tier
              // control above offers that grade once they are through the club).
              const up = !isDone && p.set.upgrade && GALLERY_GRADES.indexOf(p.set.grade) < GALLERY_GRADES.indexOf(p.set.upgrade.grade) ? p.set.upgrade : null;
              const upHtml = up
                ? `<div class="g-upgrade">⬆ upgradeable to grade ${up.grade} (${up.tokens} tokens) — ${
                    up.cards.length
                      ? `complete ${up.cards.map(esc).join(', ')} in the game (SBC/Objective)`
                      : 'complete its SBC/Objective card in the game'
                  }, then switch tier → ${up.grade}</div>`
                : '';
              return `<div class="g-mineset${isDone ? ' done' : ''}"><div class="g-mineset-top"><span class="g-mineset-info"><b>${esc(p.set.name)}</b> · grade ${p.set.grade} · ${p.done} of ${p.cards} collected${
                p.skipped > 0 ? ` · ${p.skipped} skipped` : ''
              }${why}</span><span class="g-mine-actions">${mark}<button type="button" class="ghost" data-remove-set="${p.set.id}"${off}>Remove</button></span></div>${upHtml}${switchBtns}</div>`;
            })
            .join('')}</div>`;
    return `${head}${list}<div class="g-problems" id="g-futgg-problems">${futggProblems.map(esc).join('<br>')}</div>${mine}<div class="hint">${esc(FUTGG_HELP)}</div>`;
  }

  /** Every fut.gg picker row as a flat list with its y-offset and height, so
   * the virtualizer can place and window them. One category header per group,
   * then its Sets (each once, at its best grade): completed, on-list, or to add
   * (with the buyable-grade note when its best grade needs SBC/Objective cards). */
  function buildPickerRows(g: GalleryState, off: string, busy: string): { items: PickerRow[]; total: number } {
    const onList = new Map((g.sets ?? []).map((x) => [x.id, x]));
    const completed = new Set(g.completed ?? []);
    const upgrades = futggSets ? new Map(galleryUpgradable(g, futggSets).map((u) => [u.setId, u])) : new Map<number, GalleryUpgrade>();
    const items: PickerRow[] = [];
    let top = 0;
    const push = (h: number, html: string): void => {
      items.push({ top, h, html });
      top += h;
    };
    for (const group of futggBestChoices(futggSets ?? [])) {
      push(PICKER_CAT_H, `<div class="g-cat">${esc(group.category)}</div>`);
      for (const { set, tier } of group.choices) {
        if (completed.has(set.id)) {
          const doneGrade = completedGradeOf(g, set.id) ?? tier.grade;
          const up = upgrades.get(set.id);
          const upBtn = up
            ? ` · grade ${up.to} now available <button type="button" class="g-link" data-upgrade="${set.id}"${off}${busy}>Upgrade to ${up.to} (${fmt(up.tier.cost)}${COIN})</button>`
            : '';
          push(
            PICKER_ROW_H,
            `<div class="g-set done"><span class="g-check">✓</span><span class="nm">${esc(set.name)}</span><span class="gr g${doneGrade}">${doneGrade}</span><span class="tok">Completed${completedWhen(g, set.id)}${upBtn} <button type="button" class="g-link" data-uncomplete="${set.id}"${off}>Undo</button></span></div>`,
          );
          continue;
        }
        const added = onList.get(set.id);
        const checked = added || futggPicked.has(set.id) ? ' checked' : '';
        // Best grade needs SBC/Objective cards? Add the highest grade entirely
        // on the market automatically, so the Set can be finished by buying
        // alone, and note the best grade is reachable later by doing the SBC.
        const alt = !added ? futggBuyableAlternative(set) : null;
        const need = alt ? (alt.best.sbc ?? 0) : 0;
        // The grade the Set is added at: the buyable one when the best needs SBC.
        const addTier = alt?.buyable ?? tier;
        const altHtml = alt
          ? alt.buyable
            ? `<div class="g-alt">grade ${alt.best.grade} needs ${need} SBC/Objective ${need === 1 ? 'card' : 'cards'} — adds at grade ${alt.buyable.grade} (all buyable); upgrade to ${alt.best.grade} later by completing the SBC. <button type="button" class="g-link" data-buyable="${set.id}"${off}${busy}>add grade ${alt.buyable.grade} now (${fmt(alt.buyable.cost)}${COIN})</button></div>`
            : `<div class="g-alt">grade ${alt.best.grade} needs ${need} SBC/Objective ${need === 1 ? 'card' : 'cards'} — no grade of it is fully buyable yet</div>`
          : '';
        const row = `<label class="g-set${added ? ' added' : ''}"><input type="checkbox" data-futgg="${set.id}"${checked}${added ? ' disabled' : off} /><span class="nm">${esc(
          set.name,
        )}</span><span class="gr g${addTier.grade}">${addTier.grade}</span><span class="cost">${fmt(addTier.cost)}${COIN}</span><span class="tok">${
          added ? `on your list (${added.grade})` : `${addTier.tokens} tokens`
        }</span></label>`;
        push(PICKER_ROW_H + (alt ? PICKER_ALT_H : 0), row + altHtml);
      }
    }
    return { items, total: top };
  }

  /** Puts just the rows inside (and a little past) the scroll window into the
   * spacer, each placed at its offset. Reads no layout when the list has none
   * (jsdom, or the panel hidden): then it renders every row. */
  function renderFutggWindow(): void {
    const vp = root.getElementById('gallery')?.querySelector('.g-sets') as HTMLElement | null;
    const spacer = vp?.querySelector('.g-spacer') as HTMLElement | null;
    if (!vp || !spacer || !futggItemsCache) return;
    const vpH = vp.clientHeight || Infinity;
    const min = vp.scrollTop - PICKER_OVERSCAN;
    const max = vp.scrollTop + vpH + PICKER_OVERSCAN;
    let html = '';
    for (const it of futggItemsCache.items) {
      if (it.top + it.h <= min || it.top >= max) continue;
      html += `<div class="g-item" style="top:${it.top}px">${it.html}</div>`;
    }
    spacer.innerHTML = html;
    // A tick since the list was built (which does not redraw it) lives only in
    // futggPicked, so set each enabled checkbox from it after injecting.
    spacer.querySelectorAll<HTMLInputElement>('input[data-futgg]').forEach((cb) => {
      if (!cb.disabled) cb.checked = futggPicked.has(Number(cb.dataset.futgg));
    });
  }

  /** Wires up the virtualized picker after the gallery is (re)drawn: restores
   * the scroll position, fills the window, and re-fills it as the user scrolls
   * (throttled to one fill per frame). */
  function mountFutggList(): void {
    const vp = root.getElementById('gallery')?.querySelector('.g-sets') as HTMLElement | null;
    if (!vp || !futggItemsCache) return;
    if (futggScroll > 0) vp.scrollTop = futggScroll;
    renderFutggWindow();
    let raf = 0;
    vp.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderFutggWindow();
      });
    });
  }

  /** Loads fut.gg's Sets into the picker. */
  async function loadFutggSets(): Promise<void> {
    if (!deps.futggSets || futggBusy) return;
    futggBusy = 'sets';
    futggProblems = [];
    renderGallery();
    const sets = await deps.futggSets().catch(() => null);
    futggBusy = null;
    if (sets) futggSets = sets;
    else futggProblems = ['fut.gg could not be reached: try again in a minute'];
    renderGallery();
  }

  /** Puts the ticked Sets' lineups on the list: their cards and every
   * other card that counts for them asked of the club first, so cards the
   * club holds are not bought and its players can stand in. */
  async function addFutggSets(): Promise<void> {
    const sniper = deps.getSniper();
    if (!deps.futggLineup || !futggSets || futggBusy || sniper?.isRunning()) return;
    futggBusy = 'add';
    futggProblems = [];
    renderGallery();
    const lineups: { lineup: FutggLineup; upgrade?: GallerySet['upgrade'] }[] = [];
    for (const [id, grade] of [...futggPicked]) {
      const set = futggSets.find((x) => x.id === id);
      if (!set) continue;
      const lineup = await deps.futggLineup(id, grade).catch(() => null);
      if (!lineup) {
        futggProblems.push(`${set.name}: fut.gg did not send its grade ${grade} lineup — try again`);
        continue;
      }
      // Added below its best grade because that grade needs an SBC/Objective
      // card? Read the best grade's lineup to name the blocking card(s), and
      // keep it as the Set's upgrade target.
      const best = bestFutggTier(set);
      let upgrade: GallerySet['upgrade'] | undefined;
      if (best && best.grade !== grade && (best.sbc ?? 0) > 0) {
        const bestLineup = await deps.futggLineup(id, best.grade).catch(() => null);
        upgrade = { grade: best.grade, tokens: best.tokens, cards: bestLineup ? futggSbcCards(bestLineup) : [] };
      }
      lineups.push({ lineup, upgrade });
    }
    let g = currentGallery();
    let added = 0;
    let owned = 0;
    let swapped = 0;
    let sbc = 0;
    let sets = 0;
    let cost = 0;
    let clubRead = false;
    if (lineups.length > 0) {
      const club = sniper ? await sniper.readClub(futggClubIds(lineups.map((l) => l.lineup))) : null;
      const held = new Set(club?.ok ? club.owned : []);
      clubRead = club?.ok === true;
      if (!club?.ok) futggProblems.push(`Could not check your club (${club?.why ?? 'Nova AI is not ready'}): Nova buys every card (a Start checks again)`);
      for (const { lineup, upgrade } of lineups) {
        const r = addFutggLineup(g, lineup, catalog?.rarities ?? [], held, upgrade);
        futggProblems.push(...r.problems);
        for (const x of r.swaps) futggProblems.push(`${lineup.set.name}: your ${x.in.rating} ${x.in.name} stands in for ${x.out.rating} ${x.out.name} (saves about ${fmt(x.out.price)})`);
        if (r.state === g) continue;
        g = r.state;
        added += r.added;
        owned += r.owned;
        sbc += r.sbc;
        swapped += r.swaps.length;
        sets++;
        cost += r.state.sets?.find((x) => x.id === lineup.set.id)?.cost ?? 0;
        futggPicked.delete(lineup.set.id);
      }
    }
    if (sets > 0) {
      markCompletedSets(g);
      await deps.saveGallery?.(g);
      const left = g.budget - g.spent;
      const parts = [`${added} cards`];
      if (owned > 0) parts.push(`${owned} in your club already`);
      if (sbc > 0) parts.push(`${sbc} SBC/Objective (not on the market — collect ${sbc === 1 ? 'it' : 'them'} in the game)`);
      if (swapped > 0) parts.push(`${swapped} swapped for players you own`);
      if (!clubRead) parts.push('your club was not checked');
      else if (owned === 0 && swapped === 0) parts.push('none in your club');
      const over = cost > left;
      if (over) parts.push(`fut.gg prices them at ${fmt(cost)}, more than the ${fmt(left)} left of your budget`);
      say(`Added ${sets === 1 ? '1 Set' : `${sets} Sets`}: ${parts.join(' · ')}`, over);
    }
    futggBusy = null;
    renderGallery();
    renderRunbar();
    renderBids();
  }

  /** Upgrades a completed Set to the higher grade fut.gg now lists: re-opens
   * it and puts the higher grade's lineup on the list, with every card the
   * trader already owns (the club now, and the catalogue of all it has ever
   * clubbed) marked owned, so only the cards the higher grade adds are bought. */
  async function upgradeFutggSet(setId: number): Promise<void> {
    const sniper = deps.getSniper();
    if (!deps.futggLineup || !futggSets || futggBusy || sniper?.isRunning()) return;
    const set = futggSets.find((x) => x.id === setId);
    const best = set ? bestFutggTier(set) : null;
    if (!set || !best) return;
    futggBusy = 'add';
    futggProblems = [];
    renderGallery();
    const lineup = await deps.futggLineup(setId, best.grade).catch(() => null);
    let g = currentGallery();
    if (!lineup) {
      futggProblems.push(`${set.name}: fut.gg did not send its grade ${best.grade} lineup — try again`);
    } else {
      const [club, catalogue] = await Promise.all([
        sniper ? sniper.readClub(futggClubIds([lineup])) : Promise.resolve(null),
        deps.galleryOwned?.() ?? Promise.resolve(null),
      ]);
      const held = new Set<number>([...(club?.ok ? club.owned : []), ...(catalogue ?? [])]);
      if (!club?.ok) futggProblems.push(`Could not check your club (${club?.why ?? 'Nova AI is not ready'}): a Start checks it again`);
      // Re-open the Set so its cards are worked again, then add the higher
      // grade's lineup over what is there; owned cards come in already collected.
      const reopened = setCompleted(g, setId, false);
      const r = addFutggLineup(reopened, lineup, catalog?.rarities ?? [], held);
      futggProblems.push(...r.problems);
      for (const x of r.swaps) futggProblems.push(`${set.name}: your ${x.in.rating} ${x.in.name} stands in for ${x.out.rating} ${x.out.name}`);
      if (r.state !== reopened) {
        g = r.state;
        const toBuy = r.added - r.owned - r.sbc;
        futggPicked.delete(setId);
        await deps.saveGallery?.(g);
        say(
          `Upgrading ${set.name} to grade ${best.grade}: ${toBuy > 0 ? `${toBuy} new ${toBuy === 1 ? 'card' : 'cards'} to buy` : 'nothing new to buy'}` +
            `${r.owned > 0 ? ` · ${r.owned} you already own` : ''}${r.sbc > 0 ? ` · ${r.sbc} SBC/Objective` : ''}`,
          false,
        );
      }
    }
    futggBusy = null;
    renderGallery();
    renderRunbar();
    renderBids();
  }

  /** Puts a Set on the list at a chosen grade, re-planned from scratch: any
   * lineup already on the list for the Set is dropped first, then the grade's
   * lineup is added with every card the trader owns (the club now and the
   * catalogue) standing in, so only that grade's gaps are bought. Used both to
   * add a Set at its best fully-buyable grade and to drop a stuck Set to a
   * lower, cheaper grade it can finish by buying — e.g. a Set held up by an
   * SBC/Objective card fut.gg still prices (so it reads as "to buy") that the
   * trader cannot actually get, where a lower grade's 15th card is any cheap
   * buyable player. */
  async function switchFutggSetGrade(setId: number, grade: GalleryGrade): Promise<void> {
    const sniper = deps.getSniper();
    if (!deps.futggLineup || !futggSets || futggBusy || sniper?.isRunning()) return;
    const set = futggSets.find((x) => x.id === setId);
    const tier = set?.tiers.find((t) => t.grade === grade && t.cards > 0);
    if (!set || !tier) return;
    futggBusy = 'add';
    futggProblems = [];
    renderGallery();
    const lineup = await deps.futggLineup(setId, grade).catch(() => null);
    let g = currentGallery();
    if (!lineup) {
      futggProblems.push(`${set.name}: fut.gg did not send its grade ${grade} lineup — try again`);
    } else {
      const [club, catalogue] = await Promise.all([
        sniper ? sniper.readClub(futggClubIds([lineup])) : Promise.resolve(null),
        deps.galleryOwned?.() ?? Promise.resolve(null),
      ]);
      const held = new Set<number>([...(club?.ok ? club.owned : []), ...(catalogue ?? [])]);
      if (!club?.ok) futggProblems.push(`Could not check your club (${club?.why ?? 'Nova AI is not ready'}): a Start checks it again`);
      // Drop any lineup already on the list for this Set, then add the chosen
      // grade's; owned cards come in already collected.
      const dropped = removeFutggSet(g, setId);
      const r = addFutggLineup(dropped, lineup, catalog?.rarities ?? [], held);
      futggProblems.push(...r.problems);
      for (const x of r.swaps) futggProblems.push(`${set.name}: your ${x.in.rating} ${x.in.name} stands in for ${x.out.rating} ${x.out.name}`);
      if (r.state !== dropped) {
        g = r.state;
        const toBuy = r.added - r.owned - r.sbc;
        futggPicked.delete(setId);
        await deps.saveGallery?.(g);
        say(
          `${set.name} set to grade ${grade}${(tier.sbc ?? 0) === 0 ? ' (all buyable)' : ''}: ${toBuy > 0 ? `${toBuy} ${toBuy === 1 ? 'card' : 'cards'} to buy` : 'nothing to buy'}` +
            `${r.owned > 0 ? ` · ${r.owned} you already own` : ''}${r.sbc > 0 ? ` · ${r.sbc} SBC/Objective` : ''}`,
          false,
        );
      }
    }
    futggBusy = null;
    renderGallery();
    renderRunbar();
    renderBids();
  }

  /** Adds (or switches) a Set at its best fully-buyable grade — the highest
   * grade with no SBC/Objective card. */
  async function addBuyableFutggSet(setId: number): Promise<void> {
    const set = futggSets?.find((x) => x.id === setId);
    const buyable = set ? bestBuyableFutggTier(set) : null;
    if (buyable) await switchFutggSetGrade(setId, buyable.grade);
  }

  /** Saves a changed list (the bot takes it at once while stopped). */
  function commitGallery(next: GalleryState, message = 'Saved'): void {
    void deps.saveGallery?.(next).then(() => {
      say(message, false);
      setTimeout(() => ($('saved').textContent = ''), 1500);
    });
    renderGallery();
    renderRunbar();
    renderBids();
  }

  function onGalleryClick(id: string): void {
    if (deps.getSniper()?.isRunning()) return;
    const g = currentGallery();
    if (id === 'g-load') {
      const text = (root.getElementById('g-list') as HTMLTextAreaElement | null)?.value ?? galleryDraft ?? '';
      // fut.gg's cards stay as they are: the box holds the typed ones.
      const exact = g.cards.filter((c) => c.exact);
      const parsed = parseGalleryList(text, catalog?.players ?? [], g.cards.filter((c) => !c.exact), catalog?.rarities ?? []);
      const room = GALLERY_LIMITS.cards - exact.length;
      if (parsed.cards.length > room) parsed.problems.push(`The list holds at most ${GALLERY_LIMITS.cards} cards: ${parsed.cards.length - room} typed cards were left out`);
      const typed = parsed.cards.slice(0, Math.max(0, room));
      galleryProblems = parsed.problems;
      galleryDraft = text;
      commitGallery({ ...g, cards: [...exact, ...typed] }, `Loaded ${typed.length} cards`);
    } else if (id === 'g-retry') {
      const cards = g.cards.map((c) => {
        if (c.status !== 'skipped') return c;
        const { note: _note, ...rest } = c;
        return { ...rest, status: 'todo' as const };
      });
      commitGallery({ ...g, cards });
    } else if (id === 'g-clear') {
      galleryDraft = '';
      galleryProblems = [];
      futggProblems = [];
      const { sets: _sets, ...rest } = g;
      commitGallery({ ...rest, cards: [], spent: 0 }, 'List cleared');
    } else if (id === 'g-reset-spent') {
      commitGallery({ ...g, spent: 0 });
    } else if (id === 'g-futgg') {
      void loadFutggSets();
    } else if (id === 'g-add') {
      void addFutggSets();
    }
  }

  /** EA's tab row over the left panel: the search, or the bot's settings. */
  function showTab(tab: 'search' | 'settings'): void {
    $('settings').dataset.tab = tab;
    for (const b of root.querySelectorAll<HTMLElement>('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    root.querySelector('.settings-scroll')?.scrollTo?.({ top: 0 });
  }

  // ---- recent searches ----------------------------------------------------

  let recent: RecentSearch[] = [];
  /** Bumped by each load, so only the latest one is applied. */
  let recentLoads = 0;
  /** Searches started while a load is in flight, kept on top of what it reads. */
  let startedWhileLoading: RecentSearch[] | null = null;

  function renderRecent(): void {
    const wasOpen = root.querySelector('#recent details')?.hasAttribute('open') ?? true;
    const body = recent.length
      ? recent
          .map(
            (r, i) => `<button type="button" class="recent" data-recent="${i}" title="Search with this again">
              <span class="rc-main"><span class="rc-name">${esc(r.name)}</span><span class="rc-when">${esc(timeOfDay(r.at))}${
                new Date(r.at).toDateString() === new Date().toDateString() ? '' : `, ${esc(new Date(r.at).toLocaleDateString())}`
              }</span></span>
              <span class="rc-use">Use</span></button>`,
          )
          .join('')
      : '<div class="hint">Every search you start the bot on shows up here. Click one to fill the search with it again.</div>';
    $('recent').innerHTML = section('Recent searches', body, '', wasOpen);
  }

  /** Picks up the log kept from earlier page loads, each time the page
   * opens: it is the account's, so another browser (or signing in since)
   * may have changed it. What is read replaces the list, apart from
   * searches started while it loaded. A load that fails keeps the list. */
  function loadRecent(): void {
    const store = deps.recentSearches;
    if (!store) return;
    const load = ++recentLoads;
    const meanwhile = (startedWhileLoading ??= []);
    void store.load().then(
      (raw) => {
        if (load !== recentLoads) return;
        startedWhileLoading = null;
        // Oldest first, so each search keeps its latest run, and one
        // started while this loaded stays on top.
        let merged: RecentSearch[] = [];
        for (const r of [...parseRecentSearches(raw), ...meanwhile].sort((a, b) => a.at - b.at))
          merged = addRecentSearch(merged, r);
        recent = merged;
        renderRecent();
        // Those were saved over a list this had not read yet: save again.
        if (meanwhile.length > 0) void store.save(recent).catch(() => undefined);
      },
      () => {
        if (load === recentLoads) startedWhileLoading = null;
      },
    );
  }

  const copyForm = (f: TargetForm): TargetForm => ({ ...f, player: f.player ? { ...f.player } : null });

  function rememberSearch(name: string): void {
    const entry: RecentSearch = { at: Date.now(), name, form: copyForm(form) };
    recent = addRecentSearch(recent, entry);
    startedWhileLoading?.push(entry);
    renderRecent();
    void deps.recentSearches?.save(recent).catch(() => undefined);
  }

  onTrusted($('recent'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-recent]');
    if (!el) return;
    const r = recent[Number(el.dataset.recent)];
    if (!r) return;
    form = copyForm(r.form);
    openDd = null;
    suggestions = [];
    renderTargets();
    say('Search filled in', false);
  });

  /** Auto-sell: what happens to a card right after the bot buys it. */
  function autoSellSection(s: BotSettings): string {
    const a = s.autoSell;
    const choice = (attr: string, value: string, on: boolean, label: string) =>
      `<button type="button" class="preset" data-${attr}="${value}" aria-pressed="${on}"><b>${esc(label)}</b></button>`;
    const market = a.mode === 'market';
    const body =
      field(
        'Sell at',
        market ? "FUTBIN's price, or Nova's market data when FUTBIN has none" : 'The same buy-now price for every card',
        `<div class="presets">${choice('as-mode', 'market', market, 'Market price')}${choice('as-mode', 'fixed', !market, 'Fixed price')}</div>`,
      ) +
      (market
        ? field(
            'Price steps',
            "EA price steps above (+) or below (-) the market price. 0 sells at it",
            stepper('as-steps', signedSteps(a.steps), 'steps', 'Price steps'),
          ) +
          field(
            'FUTBIN prices',
            'The market your cards sell on',
            `<div class="presets">${choice('as-platform', 'console', a.platform === 'console', 'Console')}${choice('as-platform', 'pc', a.platform === 'pc', 'PC')}</div>`,
          )
        : field(
            'Fixed price',
            'Set under your max buy price in Search, with the profit it makes. The starting bid is one step lower',
            `<span class="amt">${fmt(a.fixedPrice)}${COIN}</span>`,
          )) +
      field(
        'Never sell at a loss',
        "Don't list a card for less than it cost, after EA's 5% tax",
        toggle('as-noloss', a.noLoss, 'Never sell at a loss'),
      ) +
      `<div class="hint" id="as-modes">${esc(AUTO_SELL_MODES_HINT)}</div>`;
    return section('Auto-sell', body, `&nbsp;${toggle('as-on', a.enabled, 'Auto-sell')}`, a.enabled);
  }

  /** Bid mode's own settings, on the Settings tab while Bid is picked. */
  function biddingSection(): string {
    const b = modeSettings.bidding;
    return section(
      'Bidding',
      field(
        'Bid in the last',
        'Minutes left on an auction when Nova AI may bid on it',
        stepper('bd-window', String(b.windowMinutes), 'min', 'Bid in the last'),
      ) +
        field(
          'Bids at once',
          'Most auctions holding one of your bids at the same time',
          stepper('bd-active', String(b.maxActiveBids), 'bids', 'Bids at once'),
        ) +
        field(
          'Bids per hour',
          'Most bids and re-bids in any hour',
          stepper('bd-bph', String(b.maxBidsPerHour), 'per hr', 'Bids per hour'),
        ) +
        `<div class="hint">Your max price in Search is the most Nova AI bids for a player. When someone outbids it, it bids again one step higher, up to that max.</div>`,
    );
  }

  /** Whether the search has a price Bid mode can bid up to: its max price,
   * or "Most you'll pay". */
  function hasMaxBid(filter: FilterCriteria): boolean {
    return (filter.maxPrice ?? 0) > 0 || shown().thresholds.maxBuyPrice > 0;
  }

  /** Reads Bid mode's fields; null (and the bad one marked) if one is invalid. */
  function readModeSettings(): BotModeSettings | null {
    const num = (id: string, fallback: number) => {
      const el = root.getElementById(id) as HTMLInputElement | null;
      if (!el) return fallback;
      const v = Number(el.value.replace(/[,\s]/g, ''));
      return el.value.trim() !== '' && Number.isFinite(v) ? v : NaN;
    };
    const b = modeSettings.bidding;
    const ids = { windowMinutes: 'bd-window', maxActiveBids: 'bd-active', maxBidsPerHour: 'bd-bph' } as const;
    const next = {
      mode: modeSettings.mode,
      bidding: {
        windowMinutes: num(ids.windowMinutes, b.windowMinutes),
        maxActiveBids: num(ids.maxActiveBids, b.maxActiveBids),
        maxBidsPerHour: num(ids.maxBidsPerHour, b.maxBidsPerHour),
      },
    };
    const parsed = botModeSettingsSchema.safeParse(next);
    for (const [key, id] of Object.entries(ids)) {
      const bad = !parsed.success && parsed.error.issues.some((i) => i.path[1] === key);
      root.getElementById(id)?.setAttribute('aria-invalid', String(bad));
    }
    if (!parsed.success) {
      say(parsed.error.issues[0]?.message ? `Not saved: ${parsed.error.issues[0].message}` : 'Not saved');
      return null;
    }
    return parsed.data;
  }

  /** Applies a change of mode or of Bid mode's settings: given to the bot at
   * once (the mode itself applies at the next Start) and saved. */
  function commitMode(next: BotModeSettings, rerender: boolean): void {
    modeSettings = next;
    deps.getSniper()?.setModeSettings(next);
    if (rerender) {
      renderKnobs();
      renderTargets();
      renderGallery();
      renderBids();
    }
    renderRunbar();
    if (modeSaveTimer) clearTimeout(modeSaveTimer);
    modeSaveTimer = setTimeout(() => {
      void deps.saveModeSettings?.(modeSettings).then(() => {
        say('Saved', false);
        setTimeout(() => ($('saved').textContent = ''), 1500);
      });
    }, 400);
  }

  function signedSteps(n: number): string {
    return n > 0 ? `+${n}` : String(n);
  }

  /** Settings above low the user has not confirmed yet: shown on the page,
   * not saved and not given to the bot until the acknowledgment. */
  let pending: BotSettings | null = null;

  /** What the page shows: the unconfirmed edit, else the saved settings. */
  function shown(): BotSettings {
    return pending ?? settings;
  }

  /** Whether the acknowledgment is outstanding: an unconfirmed edit, or
   * saved settings above low that were never confirmed (an older build's). */
  function ackNeeded(): boolean {
    const s = shown();
    return botRiskLevel(s).level !== 'low' && !s.riskAcknowledgedAt;
  }

  function riskBoxHtml(): string {
    return `<section class="riskbox" id="riskbox" aria-labelledby="risk-title">
      <div class="riskhead"><b id="risk-title">Risk level <span id="risk-level"></span></b><span class="spacer"></span>
        <button type="button" id="preset-bursts" title="${esc(SHORT_BURSTS_HINT)}">Short bursts</button>
        <button type="button" id="reset-rec">Reset to recommended</button></div>
      <div class="riskbar" id="riskbar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div id="risk-proj"></div>
      <ul id="risk-reasons"></ul>
      <div class="ackbox" id="ackbox" hidden>
        <p><b>These settings are above Low risk.</b> Confirm once to save them. A ban is never refundable.</p>
        <label><input type="checkbox" id="ack-check" /> <span>${esc(RISK_ACKNOWLEDGMENT)}</span></label>
        <button type="button" class="danger" id="ack-confirm" disabled>Save these settings</button>
      </div>
      <div class="hint">Based on limits traders have reported for EA's transfer market. Not a guarantee — EA doesn't publish its rules.</div>
    </section>`;
  }

  function renderKnobs(): void {
    const s = shown();
    const delayPreset = SEARCH_DELAY_PRESETS.find(
      (p) => p.min === s.searchDelay.min && p.max === s.searchDelay.max,
    )?.key;
    const presetLevel = (p: { min: number; max: number }): BotRiskLevel =>
      botRiskLevel({ ...s, searchDelay: { min: p.min, max: p.max } }).level;

    $('knobs').innerHTML =
      riskBoxHtml() +
      (bidMode() ? biddingSection() : '') +
      section(
        'Search speed',
        field(
          'Wait between searches',
          'Seconds between one search and the next',
          stepper('delay', rangeText(s.searchDelay), 'sec', 'Wait between searches'),
        ) +
          `<div class="presets">${SEARCH_DELAY_PRESETS.map((p) => {
            const level = presetLevel(p);
            return `<button type="button" class="preset" data-delay="${p.key}" data-min="${p.min}" data-max="${p.max}" aria-pressed="${delayPreset === p.key}">
            <b>${p.min}-${p.max}</b><small class="tag-${level}">${esc(BOT_RISK_LABELS[level].toUpperCase())}</small></button>`;
          }).join('')}</div>` +
          `<div class="hint" id="pace" aria-live="polite"></div>`,
      ) +
      section(
        'Short breaks',
        field(
          'Take a break after',
          'Searches before the bot pauses',
          stepper('b-searches', rangeText(s.breaks.searches), 'searches', 'Take a break after'),
        ) +
          field(
            'Break length',
            'Seconds the bot pauses',
            stepper('b-seconds', rangeText(s.breaks.seconds), 'sec', 'Break length'),
          ),
        `&nbsp;${toggle('b-on', s.breaks.enabled, 'Take short breaks')}`,
      ) +
      section(
        'Long breaks',
        field(
          'Rest after',
          'Minutes of searching before a long break',
          stepper('r-after', rangeText(s.rest.afterMinutes), 'min', 'Rest after', true),
        ) +
          field(
            'Rest length',
            'Minutes the bot rests',
            stepper('r-minutes', rangeText(s.rest.minutes), 'min', 'Rest length', true),
          ) +
          `<div class="hint">Enter one number (30) or a range (20-30). The bot picks a random value in the range each time.</div>`,
        `&nbsp;<span class="badge-rec">Recommended</span>${toggle('r-on', s.rest.enabled, 'Take long breaks')}`,
      ) +
      section(
        'Price limits',
        field(
          "Most you'll pay",
          'Per player. 0 uses the max price in your search',
          stepper('t-max', String(s.thresholds.maxBuyPrice), 'coins', "Most you'll pay", true),
        ) +
          field(
            'Minimum profit',
            "After EA's 5% tax. 0 turns it off",
            stepper('t-profit', String(s.thresholds.minProfit), 'coins', 'Minimum profit', true),
          ) +
          field(
            'Stop after buying',
            'Number of players. 0 means no limit',
            stepper('t-buys', String(s.thresholds.stopAfterPurchases), 'players', 'Stop after buying'),
          ) +
          field(
            'Spending limit',
            'Stop after spending this many coins. 0 means no limit',
            stepper('t-budget', String(s.thresholds.sessionCoinBudget), 'coins', 'Spending limit', true),
          ),
        '',
        false,
      ) +
      autoSellSection(s) +
      section(
        'Safety limits',
        field(
          'Searches per hour',
          'Most searches in any hour',
          stepper('s-sph', String(s.safety.maxSearchesPerHour), 'per hr', 'Searches per hour'),
        ) +
          field(
            'Buys per hour',
            'Most players bought in any hour. A missed buy does not count',
            stepper('s-bph', String(s.safety.maxBuysPerHour), 'per hr', 'Buys per hour'),
          ) +
          field(
            'Hours per day',
            'Most time searching each day, breaks not counted',
            stepper('s-hours', String(s.safety.maxActiveHoursPerDay), 'hours', 'Hours per day'),
          ) +
          field(
            'Coins per hour',
            'Most coins spent in any hour. A missed buy does not count',
            stepper('s-flow', String(s.safety.maxCoinFlowPerHour), 'coins', 'Coins per hour', true),
          ) +
          field(
            'Pause after a buy',
            'Seconds to wait after each purchase',
            stepper('s-cooldown', String(s.safety.cooldownSeconds), 'sec', 'Pause after a buy'),
          ) +
          field(
            'Buys per search',
            'From 0.01 to 1. Lower is safer',
            stepper('s-ratio', String(s.safety.buyToSearchRatio), 'max', 'Buys per search'),
          ),
        '',
        false,
      );
    renderRisk();
  }

  // ---- Search: built like EA's own search panel ----------------------------
  //
  // Same layout as the web app's Club / Transfer Market search: OVR range,
  // player name search, then expandable rows (Quality, Rarity, Position,
  // Chemistry Style, Country/Region, League, Club) and the Buy Now price.
  // What the user has chosen lives in `form`, so re-rendering (opening a row,
  // picking an option) never loses it.

  type Dd = 'quality' | 'rarity' | 'position' | 'chem' | 'nation' | 'league' | 'club';
  const DDS: Dd[] = ['quality', 'rarity', 'position', 'chem', 'nation', 'league', 'club'];

  let form = blankForm();
  let openDd: Dd | null = null;
  // Type-to-jump in an open list, like a native dropdown (EA's lists have
  // no search box).
  let typeahead = '';
  let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;
  let suggestions: CatalogPlayer[] = [];

  const DD_LABEL: Record<Dd, string> = {
    quality: 'Quality',
    rarity: 'Rarity',
    position: 'Position',
    chem: 'Chemistry Style',
    nation: 'Country/Region',
    league: 'League',
    club: 'Club',
  };

  const svg = (body: string) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${body}</svg>`;
  const DD_ICON: Record<Dd, string> = {
    quality: svg(
      '<path d="M5 3h14v11c0 4-4 6-7 7-3-1-7-3-7-7z" fill="#fff"/><text x="12" y="12.5" text-anchor="middle" font-size="6.5" font-weight="900" font-style="italic" fill="#1b2433">FUT</text>',
    ),
    rarity: svg(
      '<ellipse cx="12" cy="6" rx="7" ry="2.6" fill="#fff"/><path d="M5 6v11c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6c0 1.5-3.1 2.7-7 2.7S5 7.5 5 6z" fill="#cfd6df"/>',
    ),
    position: svg(
      '<circle cx="12" cy="4.5" r="2.3" fill="#fff"/><path d="M9.5 8h5l1 6-2 .5-.5 8h-2l-.5-8-2-.5z" fill="#fff"/>',
    ),
    chem: svg(
      '<path d="M3 15c3 0 6-1 8-4l2 2c1 1 3 2 5 2h3v3H4c-.6 0-1-.4-1-1z" fill="#fff"/><path d="M6 19h2v1H6zm4 0h2v1h-2zm4 0h2v1h-2z" fill="#fff"/>',
    ),
    nation: svg(
      '<path d="M5 3v18" stroke="#fff" stroke-width="1.6"/><path d="M5.5 4h9l-1.5 3 1.5 3h-9z" fill="#fff"/><circle cx="17" cy="16" r="3.2" fill="none" stroke="#fff" stroke-width="1.4"/>',
    ),
    league: svg(
      '<path d="M4 7l4 3 4-6 4 6 4-3-2 10H6z" fill="#fff"/><rect x="6" y="18" width="12" height="2" fill="#fff"/>',
    ),
    club: svg('<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" fill="#fff"/>'),
  };

  /** Used only until the web app has started and the adapter has built
   * the catalog from EA's own lists (they need no id to be meaningful). */
  const LEVEL_IMG =
    'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/images/SearchFilters/level/';
  const FALLBACK_LEVELS: CatalogOption[] = [
    { id: 0, value: 'bronze', label: 'Bronze', img: `${LEVEL_IMG}bronze.png` },
    { id: 1, value: 'silver', label: 'Silver', img: `${LEVEL_IMG}silver.png` },
    { id: 2, value: 'gold', label: 'Gold', img: `${LEVEL_IMG}gold.png` },
    { id: 3, value: SPECIAL_LEVEL, label: 'Special', img: `${LEVEL_IMG}SP.png` },
  ];

  /** EA's list for a row, exactly as the web app's search panel shows it. */
  function ddOptions(dd: Dd): CatalogOption[] {
    switch (dd) {
      case 'quality':
        return catalog?.levels.length ? catalog.levels : FALLBACK_LEVELS;
      case 'rarity':
        return raritiesForLevel(catalog?.rarities ?? [], form.quality);
      case 'position':
        return catalog?.positions ?? [];
      case 'chem':
        return catalog?.playStyles ?? [];
      case 'nation':
        return catalog?.nations ?? [];
      case 'league':
        return catalog?.leagues ?? [];
      case 'club':
        return form.league == null ? [] : (catalog?.clubs[String(form.league)] ?? []);
    }
  }

  function ddValue(dd: Dd): string | null {
    const v = {
      quality: form.quality,
      rarity: form.rarity,
      position: form.position,
      chem: form.chem,
      nation: form.nation,
      league: form.league,
      club: form.club,
    }[dd];
    return v == null ? null : String(v);
  }

  /** The chosen entry of a row (by EA value for quality/position, by id otherwise). */
  function ddChosen(dd: Dd): CatalogOption | null {
    const v = ddValue(dd);
    if (v == null) return null;
    const byValue = dd === 'quality' || dd === 'position';
    return ddOptions(dd).find((o) => (byValue ? o.value : String(o.id)) === v) ?? null;
  }

  function ddLabel(dd: Dd): string | null {
    const v = ddValue(dd);
    if (v == null) return null;
    return ddChosen(dd)?.label ?? `#${v}`;
  }

  /** Mirrors the web app's search panel: picking a quality clears the
   * rarity (its `LEVEL` filter sets `rarities = []`), and a new league
   * clears the club (a club belongs to one league). */
  function setDd(dd: Dd, value: string | null): void {
    const n = value == null ? null : Number(value);
    if (dd === 'quality') {
      form.quality = value;
      form.rarity = null;
    } else if (dd === 'position') form.position = value;
    else if (dd === 'rarity') form.rarity = n;
    else if (dd === 'chem') form.chem = n;
    else if (dd === 'nation') form.nation = n;
    else if (dd === 'league') {
      if (form.league !== n) form.club = null;
      form.league = n;
    } else form.club = n;
  }

  const IMG_CLASS: Record<Dd, string> = {
    quality: 'img-level',
    rarity: 'img-card',
    position: 'img-pos',
    chem: 'img-chem',
    nation: 'img-flag',
    league: 'img-logo',
    club: 'img-logo',
  };

  /** EA's picture for an entry, with the name's initials if it will not load. */
  function optVisual(dd: Dd, o: CatalogOption): string {
    const initials = esc(
      o.label
        .replace(/\(.*?\)/g, '')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase(),
    );
    return `<span class="opt-img ${IMG_CLASS[dd]}${o.img ? '' : ' noimg'}" data-initials="${initials}">${
      o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''
    }</span>`;
  }

  function ddOptionsHtml(dd: Dd): string {
    const current = ddChosen(dd);
    return ddOptions(dd)
      .map((o) => {
        const val = dd === 'quality' || dd === 'position' ? o.value : String(o.id);
        return `<button type="button" class="dd-opt" role="option" aria-selected="${o === current}" data-opt="${dd}" data-val="${esc(val)}">${optVisual(dd, o)}<span>${esc(o.label)}</span></button>`;
      })
      .join('');
  }

  function ddHtml(dd: Dd): string {
    const label = ddLabel(dd);
    const chosen = ddChosen(dd);
    // Like EA's panel: Club stays disabled until a league is chosen.
    const disabled = dd === 'club' && form.league == null;
    const open = openDd === dd && !disabled;
    const options = ddOptions(dd);
    let panel = '';
    if (open) {
      panel =
        options.length === 0
          ? `<div class="dd-panel"><div class="dd-empty">${
              catalog
                ? 'Nothing to choose here.'
                : "Loading EA's lists. Keep the web app open and signed in."
            }</div></div>`
          : `<div class="dd-panel"><div class="dd-opts" id="dd-opts" role="listbox" aria-label="${esc(DD_LABEL[dd])}">${ddOptionsHtml(dd)}</div></div>`;
    }
    return `<div class="dd${open ? ' open' : ''}${label ? ' set' : ''}${disabled ? ' disabled' : ''}">
      <button type="button" class="dd-row" data-dd="${dd}" aria-expanded="${open}" ${disabled ? 'disabled aria-disabled="true"' : ''}>
        <span class="dd-icon">${chosen ? optVisual(dd, chosen) : DD_ICON[dd]}</span>
        <span class="dd-label">${label ? `<small>${esc(DD_LABEL[dd])}</small>${esc(label)}` : esc(DD_LABEL[dd])}</span>
        ${label ? `<span class="dd-clear" data-clear="${dd}" role="button" aria-label="Clear ${esc(DD_LABEL[dd])}">✕</span>` : ''}
        <span class="dd-caret">${open ? '▲' : '▼'}</span>
      </button>${panel}</div>`;
  }

  function describeFilter(f: FilterCriteria): string[] {
    const byId = (list: CatalogOption[] | undefined, id: number) =>
      list?.find((e) => e.id === id)?.label;
    const chips: string[] = [];
    if (f.resourceId != null) {
      const p = catalog?.players.find((x) => x.id === f.resourceId);
      chips.push(p ? `${p.rating ?? ''} ${p.name}`.trim() : `Player #${f.resourceId}`);
    }
    if (f.minRating != null || f.maxRating != null)
      chips.push(`OVR ${f.minRating ?? OVR_MIN}-${f.maxRating ?? OVR_MAX}`);
    if (f.quality) {
      const v = f.quality === 'special' ? SPECIAL_LEVEL : f.quality;
      chips.push(
        (catalog?.levels.length ? catalog.levels : FALLBACK_LEVELS).find((l) => l.value === v)
          ?.label ?? f.quality,
      );
    }
    if (f.rarity != null) chips.push(byId(catalog?.rarities, f.rarity) ?? `Rarity #${f.rarity}`);
    if (f.zone != null) chips.push(byId(catalog?.positions, f.zone) ?? `Zone #${f.zone}`);
    else if (f.position)
      chips.push(catalog?.positions.find((p) => p.value === f.position)?.label ?? f.position);
    if (f.chemistryStyle != null)
      chips.push(byId(catalog?.playStyles, f.chemistryStyle) ?? `Chem #${f.chemistryStyle}`);
    if (f.nationality != null)
      chips.push(byId(catalog?.nations, f.nationality) ?? `Nation #${f.nationality}`);
    if (f.league != null) chips.push(byId(catalog?.leagues, f.league) ?? `League #${f.league}`);
    if (f.club != null) {
      const clubs =
        f.league != null
          ? catalog?.clubs[String(f.league)]
          : Object.values(catalog?.clubs ?? {}).flat();
      chips.push(byId(clubs, f.club) ?? `Club #${f.club}`);
    }
    if (f.minPrice != null) chips.push(`min ${fmt(f.minPrice)}`);
    chips.push(f.maxPrice != null ? `max ${fmt(f.maxPrice)}` : 'no max price');
    return chips;
  }

  function ovrFill(): string {
    const span = OVR_MAX - OVR_MIN;
    return `left:${((form.minOvr - OVR_MIN) / span) * 100}%;right:${((OVR_MAX - form.maxOvr) / span) * 100}%`;
  }

  /** A section heading the way EA's panel writes them ("Buy Now Price:"),
   * with its "Clear" on the right. */
  function secHead(title: string, clear: string): string {
    return `<div class="sec-h"><span>${esc(title)}</span><button type="button" class="sec-clear" data-clear-sec="${clear}">Clear</button></div>`;
  }

  /** One price box as EA lays them out: "Min:" above, then − box +. */
  function priceHtml(key: 'minBuy' | 'maxBuy', label: string): string {
    const v = form[key];
    return `<div class="mm-col"><span class="mm-k">${label}:</span><div class="price">
      <button type="button" class="step" data-price="${key}" data-dir="-1" aria-label="Lower ${label.toLowerCase()} price">−</button>
      <input id="nf-${key}" inputmode="numeric" placeholder="Any" value="${v == null ? '' : fmt(v)}" aria-label="${label} buy now price" />
      <button type="button" class="step" data-price="${key}" data-dir="1" aria-label="Raise ${label.toLowerCase()} price">+</button></div></div>`;
  }

  /** The auto-sell price, right under the buy now prices so the two (and
   * the profit between them) read together. Empty: the FUTBIN price. */
  function sellHtml(): string {
    const a = shown().autoSell;
    return `<div class="mm"><div class="mm-col"><span class="mm-k">Sell at:</span><div class="price">
      <button type="button" class="step" data-sell-step="-1" aria-label="Lower sell price">−</button>
      <input id="nf-sell" inputmode="numeric" placeholder="FUTBIN" value="${a.mode === 'fixed' ? fmt(a.fixedPrice) : ''}" aria-label="Sell price (auto-sell)" />
      <button type="button" class="step" data-sell-step="1" aria-label="Raise sell price">+</button></div></div>
      <div class="mm-col"><div class="profit" id="nf-profit" aria-live="polite"></div></div></div>`;
  }

  /** What selling at the Sell price leaves after EA's tax, and the profit
   * per card bought at the max buy price, from what is typed right now. */
  function renderProfit(): void {
    const out = root.getElementById('nf-profit');
    if (!out) return;
    const s = shown();
    const a = s.autoSell;
    const typed = (id: string) => {
      const el = root.getElementById(id) as HTMLInputElement | null;
      return el && el.value.trim() !== '' ? parsePrice(el.value) : null;
    };
    const sell = typed('nf-sell');
    const buy = typed('nf-maxBuy') ?? form.maxBuy ?? (s.thresholds.maxBuyPrice > 0 ? s.thresholds.maxBuyPrice : null);
    let html: string;
    if (sell == null || sell <= 0) {
      html = `Sells at the FUTBIN price${a.steps ? ` ${esc(signedSteps(a.steps))} steps` : ''}. Type a price to sell at it instead.`;
    } else {
      const p = saleProfit(sell, buy);
      html = `You get <b>${fmt(p.net)}</b>${COIN} after EA's 5% tax (${fmt(p.tax)}${COIN}).`;
      html +=
        p.profit == null || buy == null
          ? ' Set a max buy price to see your profit.'
          : ` Profit <b class="${p.profit < 0 ? 'neg' : 'pos'}">${p.profit < 0 ? '−' : '+'}${fmt(Math.abs(p.profit))}</b>${COIN} per card at your max ${bidMode() ? 'bid' : 'buy'} (${fmt(buy)}), more when it buys cheaper.`;
    }
    if (!a.enabled) html += ' <span class="muted">Auto-sell is off: turn it on below to list cards at this price.</span>';
    out.innerHTML = html;
  }

  /** The Sell price as the user set it: on EA's price grid, within EA's
   * limits; empty switches back to the FUTBIN price. */
  function setSellPrice(value: number | null): void {
    const s = shown();
    if (value == null) {
      commit({ ...s, autoSell: { ...s.autoSell, mode: 'market' } }, true);
      return;
    }
    const price = Math.min(BOT_LIMITS.autoSellPrice.max, Math.max(MIN_SALE_PRICE, roundToPriceStep(value)));
    commit({ ...s, autoSell: { ...s.autoSell, mode: 'fixed', fixedPrice: price } }, true);
  }

  /** Brings the Sell field and the profit line in line with the settings
   * (after an edit in the Auto-sell card, say), unless the user is typing. */
  function syncSell(): void {
    const input = root.getElementById('nf-sell') as HTMLInputElement | null;
    if (input && root.activeElement !== input) {
      const a = shown().autoSell;
      input.value = a.mode === 'fixed' ? fmt(a.fixedPrice) : '';
    }
    renderProfit();
  }

  function renderTargets(): void {
    const players = catalog?.players.length ?? 0;
    const hint = !catalog
      ? "Loading EA's lists and players. Keep the web app open; they appear here on their own."
      : `${fmt(players)} players from EA's player list.${catalog.notes?.length ? ` Problems: ${catalog.notes.join(', ')}` : ''}`;

    $('targets').innerHTML = `<div class="ea-panel" id="ea-search">
        <div class="ea-player combo">${
          form.player
            ? `<div class="picked">${
                portraitUrl(catalog, form.player.id)
                  ? `<span class="sg-face"><img src="${esc(portraitUrl(catalog, form.player.id)!)}" alt="" referrerpolicy="no-referrer" /></span>`
                  : ''
              }<span class="r">${form.player.rating ?? ''}</span><b>${esc(form.player.name)}</b>
                <button type="button" id="nf-unpick" aria-label="Clear player">✕</button></div>`
            : `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
               <input id="nf-player" placeholder="${players > 0 ? 'Type Player Name' : 'Type Player Name or id'}" autocomplete="off" value="${esc(form.playerQuery)}"
                role="combobox" aria-label="Player" aria-expanded="false" aria-controls="nf-suggest" aria-autocomplete="list" />
               <div class="suggest" id="nf-suggest" role="listbox" hidden></div>`
        }</div>
        <div class="dd-grid">${DDS.map(ddHtml).join('')}</div>
        ${secHead('Rating:', 'ovr')}
        <div class="range2">
          <div class="track"><i id="ovr-fill" style="${ovrFill()}"></i></div>
          <input type="range" id="nf-ovr-lo" min="${OVR_MIN}" max="${OVR_MAX}" value="${form.minOvr}" aria-label="Min rating" />
          <input type="range" id="nf-ovr-hi" min="${OVR_MIN}" max="${OVR_MAX}" value="${form.maxOvr}" aria-label="Max rating" />
        </div>
        <div class="mm ovr-boxes">
          <label class="mm-col"><span class="mm-k">Min:</span><input id="nf-minovr" inputmode="numeric" value="${form.minOvr}" /></label>
          <label class="mm-col"><span class="mm-k">Max:</span><input id="nf-maxovr" inputmode="numeric" value="${form.maxOvr}" /></label>
        </div>
        ${secHead('Buy Now Price:', 'buy')}
        <div class="mm">${priceHtml('minBuy', 'Min')}${priceHtml('maxBuy', 'Max')}</div>
        ${bidMode() ? `<div class="search-hint" id="bid-hint">${esc(BID_MAX_HINT)}</div>` : ''}
        ${secHead('Sell Price:', 'sell')}
        ${sellHtml()}
        <div class="search-hint">${esc(hint)}</div>
      </div>`;
    if (openDd) {
      const opt =
        root.querySelector<HTMLElement>('.dd.open .dd-opt[aria-selected="true"]') ??
        root.querySelector<HTMLElement>('.dd.open .dd-opt');
      opt?.scrollIntoView({ block: 'nearest' });
      opt?.focus({ preventScroll: true });
    }
    syncSearch();
  }

  /** The form as the search the bot runs, or what is wrong with it. */
  function currentSearch(): { search: LiveSearch } | { error: string } {
    const built = buildFilterFromForm(form);
    if ('error' in built) return built;
    const name = describeFilter(built.filter).join(', ').slice(0, 80);
    return { search: { id: LIVE_SEARCH_ID, name, filter: built.filter } };
  }

  /** Hands the form to the bot. While it runs, an unfinished edit (say, a
   * name typed but not picked yet) keeps the last complete search. */
  function syncSearch(): void {
    const running = deps.getSniper()?.isRunning() ?? false;
    const r = currentSearch();
    if ('search' in r) deps.setLiveSearch(r.search);
    else if (!running) deps.setLiveSearch(null);
    renderRunbar();
    renderProfit();
  }

  function showSuggestions(query: string): void {
    const box = root.getElementById('nf-suggest');
    const input = root.getElementById('nf-player');
    if (!box || !input) return;
    suggestions = catalog ? searchPlayers(catalog.players, query) : [];
    box.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(!box.hidden));
    box.innerHTML = suggestions
      .map((p, i) => {
        const face = portraitUrl(catalog, p.id);
        return `<button type="button" role="option" data-pick="${i}">${
          face
            ? `<span class="sg-face"><img src="${esc(face)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
            : ''
        }<span class="r">${p.rating ?? ''}</span>${esc(p.name)}</button>`;
      })
      .join('');
  }

  function setOvr(lo: number, hi: number): void {
    const clamp = (n: number) => Math.min(OVR_MAX, Math.max(OVR_MIN, Math.round(n)));
    form.minOvr = clamp(Math.min(lo, hi));
    form.maxOvr = clamp(Math.max(lo, hi));
    const set = (id: string, v: number) => {
      const el = root.getElementById(id) as HTMLInputElement | null;
      if (el && el.value !== String(v)) el.value = String(v);
    };
    set('nf-ovr-lo', form.minOvr);
    set('nf-ovr-hi', form.maxOvr);
    set('nf-minovr', form.minOvr);
    set('nf-maxovr', form.maxOvr);
    root.getElementById('ovr-fill')?.setAttribute('style', ovrFill());
  }

  function parsePrice(text: string): number | null {
    const n = Number(text.replace(/[,\s]/g, ''));
    return text.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n));
  }

  const say = (text: string, bad = true) => {
    $('saved').style.color = bad ? 'var(--ea-danger)' : '';
    $('saved').textContent = text;
  };

  onTrusted($('targets'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-clear],button');
    if (!el) return;
    if (el.dataset.clear) {
      e.stopPropagation();
      setDd(el.dataset.clear as Dd, null);
      renderTargets();
    } else if (el.dataset.dd) {
      const dd = el.dataset.dd as Dd;
      openDd = openDd === dd ? null : dd;
      renderTargets();
    } else if (el.dataset.opt) {
      setDd(el.dataset.opt as Dd, el.dataset.val ?? null);
      openDd = null;
      renderTargets();
    } else if (el.dataset.pick) {
      const p = suggestions[Number(el.dataset.pick)];
      if (!p) return;
      form.player = p;
      form.playerQuery = '';
      suggestions = [];
      renderTargets();
    } else if (el.id === 'nf-unpick') {
      form.player = null;
      renderTargets();
    } else if (el.dataset.price) {
      const key = el.dataset.price as 'minBuy' | 'maxBuy';
      const dir = Number(el.dataset.dir) as 1 | -1;
      form[key] = priceStep(form[key] ?? 0, dir) || null;
      const input = root.getElementById(`nf-${key}`) as HTMLInputElement | null;
      if (input) input.value = form[key] == null ? '' : fmt(form[key]!);
      syncSearch();
    } else if (el.dataset.sellStep) {
      // Along EA's price grid, like the web app's own price arrows.
      const input = root.getElementById('nf-sell') as HTMLInputElement | null;
      const a = shown().autoSell;
      const base = (input ? parsePrice(input.value) : null) ?? a.fixedPrice;
      setSellPrice(stepPrice(base, Number(el.dataset.sellStep)));
    } else if (el.dataset.clearSec) {
      // A section's own "Clear", as on EA's panel.
      const sec = el.dataset.clearSec;
      if (sec === 'sell') setSellPrice(null);
      else {
        if (sec === 'ovr') setOvr(OVR_MIN, OVR_MAX);
        else form = { ...form, minBuy: null, maxBuy: null };
        renderTargets();
      }
    }
    // A button inside <summary> must not also fold the card.
    if (el.closest('summary')) e.preventDefault();
  });

  // A flag or logo EA does not have (or a guessed image path that is wrong)
  // falls back to the name's initials. `error` does not bubble: capture it.
  $('targets').addEventListener(
    'error',
    (e) => {
      const img = e.target as HTMLElement;
      if (img.tagName !== 'IMG') return;
      img.parentElement?.classList.add('noimg');
      img.remove();
    },
    true,
  );

  onTrusted($('targets'), 'input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player') {
      form.playerQuery = t.value;
      showSuggestions(t.value);
    } else if (t.id === 'nf-ovr-lo')
      setOvr(Number(t.value), Math.max(Number(t.value), form.maxOvr));
    else if (t.id === 'nf-ovr-hi') setOvr(Math.min(Number(t.value), form.minOvr), Number(t.value));
    else if (t.id === 'nf-sell' || t.id === 'nf-maxBuy') {
      // The profit follows the typing; the price itself saves on change.
      renderProfit();
      return;
    } else return;
    syncSearch();
  });

  onTrusted($('targets'), 'change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-minovr' || t.id === 'nf-maxovr') {
      const n = Number(t.value);
      if (!Number.isFinite(n)) setOvr(form.minOvr, form.maxOvr);
      else if (t.id === 'nf-minovr') setOvr(n, Math.max(n, form.maxOvr));
      else setOvr(Math.min(n, form.minOvr), n);
    } else if (t.id === 'nf-minBuy' || t.id === 'nf-maxBuy') {
      const key = t.id === 'nf-minBuy' ? 'minBuy' : 'maxBuy';
      form[key] = parsePrice(t.value);
      t.value = form[key] == null ? '' : fmt(form[key]!);
    } else if (t.id === 'nf-sell') {
      setSellPrice(parsePrice(t.value));
      // Show it as saved: on EA's grid, or empty for the FUTBIN price.
      const a = shown().autoSell;
      t.value = a.mode === 'fixed' ? fmt(a.fixedPrice) : '';
      renderProfit();
      return;
    } else return;
    syncSearch();
  });

  onTrusted($('targets'), 'keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player' && e.key === 'Enter' && suggestions[0]) {
      e.preventDefault();
      form.player = suggestions[0];
      form.playerQuery = '';
      suggestions = [];
      renderTargets();
    } else if (
      openDd &&
      t.classList?.contains('dd-opt') &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp')
    ) {
      e.preventDefault();
      const next = (
        e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling
      ) as HTMLElement | null;
      next?.focus();
    } else if (
      openDd &&
      e.key.length === 1 &&
      /\p{L}|\p{N}/u.test(e.key) &&
      !(t instanceof HTMLInputElement)
    ) {
      typeahead += fold(e.key);
      if (typeaheadTimer) clearTimeout(typeaheadTimer);
      typeaheadTimer = setTimeout(() => (typeahead = ''), 700);
      const hit = [...root.querySelectorAll<HTMLElement>('.dd.open .dd-opt')].find((b) =>
        fold(b.textContent ?? '')
          .trim()
          .startsWith(typeahead),
      );
      hit?.scrollIntoView({ block: 'nearest' });
      hit?.focus({ preventScroll: true });
    } else if (e.key === 'Escape' && openDd) {
      e.stopPropagation();
      openDd = null;
      renderTargets();
    }
  });

  function renderRisk(): void {
    const risk = botRiskLevel(shown());
    const label = BOT_RISK_LABELS[risk.level];
    const chip = $('risk');
    chip.className = `risk ${risk.level}`;
    chip.textContent = `Risk: ${label}`;
    renderRunbar();
    const box = root.getElementById('riskbox');
    if (!box) return;
    box.className = `riskbox ${risk.level}`;
    $('risk-level').textContent = label;
    $('risk-level').className = `lvl ${risk.level}`;
    $('riskbar').className = `riskbar ${risk.level}`;
    $('risk-proj').textContent = `About ${fmt(risk.projectedSearchesPerDay)} searches and ${fmt(risk.projectedBuysPerDay)} buys a day at most.`;
    $('risk-reasons').innerHTML = risk.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    const pace = root.getElementById('pace');
    if (pace) pace.textContent = paceText(shown());
    const ack = $('ackbox');
    const needed = ackNeeded();
    if (ack.hidden === needed) {
      ack.hidden = !needed;
      const check = root.getElementById('ack-check') as HTMLInputElement | null;
      if (check) check.checked = false;
      ($('ack-confirm') as HTMLButtonElement).disabled = true;
    }
  }

  /** Reads every field; returns null (and marks the bad ones) if any is invalid. */
  function readSettings(): BotSettings | null {
    let ok = true;
    const field = (id: string) => root.getElementById(id) as HTMLInputElement | null;
    const mark = (id: string, valid: boolean) => {
      field(id)?.setAttribute('aria-invalid', String(!valid));
      if (!valid) ok = false;
    };
    const rng = (id: string, integer: boolean, fallback: { min: number; max: number }) => {
      const el = field(id);
      if (!el) return fallback;
      const r = parseRange(el.value, integer);
      mark(id, r != null);
      return r ?? fallback;
    };
    const n = (id: string, fallback: number) => {
      const el = field(id);
      if (!el) return fallback;
      const v = Number(el.value.replace(/[,\s]/g, ''));
      mark(id, el.value.trim() !== '' && Number.isFinite(v));
      return Number.isFinite(v) ? v : fallback;
    };
    const s = shown();
    const next: BotSettings = {
      riskAcknowledgedAt: s.riskAcknowledgedAt,
      searchDelay: rng('delay', false, s.searchDelay),
      breaks: {
        enabled: s.breaks.enabled,
        searches: rng('b-searches', true, s.breaks.searches),
        seconds: rng('b-seconds', true, s.breaks.seconds),
      },
      rest: {
        enabled: s.rest.enabled,
        afterMinutes: rng('r-after', true, s.rest.afterMinutes),
        minutes: rng('r-minutes', true, s.rest.minutes),
      },
      thresholds: {
        maxBuyPrice: n('t-max', s.thresholds.maxBuyPrice),
        minProfit: n('t-profit', s.thresholds.minProfit),
        stopAfterPurchases: n('t-buys', s.thresholds.stopAfterPurchases),
        sessionCoinBudget: n('t-budget', s.thresholds.sessionCoinBudget),
      },
      safety: {
        maxSearchesPerHour: n('s-sph', s.safety.maxSearchesPerHour),
        maxBuysPerHour: n('s-bph', s.safety.maxBuysPerHour),
        maxActiveHoursPerDay: n('s-hours', s.safety.maxActiveHoursPerDay),
        buyToSearchRatio: n('s-ratio', s.safety.buyToSearchRatio),
        cooldownSeconds: n('s-cooldown', s.safety.cooldownSeconds),
        maxCoinFlowPerHour: n('s-flow', s.safety.maxCoinFlowPerHour),
      },
      autoSell: {
        ...s.autoSell,
        // Only the shown mode's field is on the page; the other keeps its value.
        steps: n('as-steps', s.autoSell.steps),
        fixedPrice: n('as-price', s.autoSell.fixedPrice),
      },
    };
    const parsed = botSettingsSchema.safeParse(next);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join('.') ?? '';
      const byPath: Record<string, string> = {
        searchDelay: 'delay',
        'breaks.searches': 'b-searches',
        'breaks.seconds': 'b-seconds',
        'rest.afterMinutes': 'r-after',
        'rest.minutes': 'r-minutes',
        'thresholds.maxBuyPrice': 't-max',
        'thresholds.minProfit': 't-profit',
        'thresholds.stopAfterPurchases': 't-buys',
        'thresholds.sessionCoinBudget': 't-budget',
        'safety.maxSearchesPerHour': 's-sph',
        'safety.maxBuysPerHour': 's-bph',
        'safety.maxActiveHoursPerDay': 's-hours',
        'safety.buyToSearchRatio': 's-ratio',
        'safety.cooldownSeconds': 's-cooldown',
        'safety.maxCoinFlowPerHour': 's-flow',
        'autoSell.steps': 'as-steps',
        'autoSell.fixedPrice': 'as-price',
      };
      const key = Object.keys(byPath).find((k) => path.startsWith(k));
      if (key) mark(byPath[key]!, false);
      say(parsed.error.issues[0]?.message ? `Not saved: ${parsed.error.issues[0].message}` : 'Not saved');
      return null;
    }
    return ok ? parsed.data : null;
  }

  /** Applies an edit. Above low and never confirmed: shown, but held back
   * until the acknowledgment. Otherwise saved and given to the bot. */
  function commit(next: BotSettings, rerender: boolean): void {
    if (botRiskLevel(next).level !== 'low' && !next.riskAcknowledgedAt) {
      pending = next;
      if (saveTimer) clearTimeout(saveTimer);
      if (rerender) renderKnobs();
      else renderRisk();
      say('Not saved yet: confirm the risk level above');
      return;
    }
    pending = null;
    settings = next;
    deps.getSniper()?.setSettings(next);
    if (rerender) renderKnobs();
    else renderRisk();
    syncSell();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void deps.saveSettings(settings).then(() => {
        say('Saved', false);
        setTimeout(() => ($('saved').textContent = ''), 1500);
      });
    }, 400);
  }

  const STEPS: Record<string, number> = {
    delay: 0.5,
    'b-searches': 1,
    'b-seconds': 5,
    'r-after': 5,
    'r-minutes': 5,
    't-max': 1000,
    't-profit': 500,
    't-buys': 1,
    't-budget': 10_000,
    's-sph': 25,
    's-bph': 1,
    's-hours': 1,
    's-ratio': 0.05,
    's-cooldown': 5,
    's-flow': 100_000,
    'bd-window': 1,
    'bd-active': 1,
    'bd-bph': 5,
  };

  /** Bid mode's fields save apart from the rest (`commitMode`). */
  const isModeField = (id: string): boolean => id.startsWith('bd-');

  onTrusted($('knobs'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest('button');
    if (!el) return;
    if (el.dataset.step) {
      const input = root.getElementById(el.dataset.step) as HTMLInputElement;
      const dir = Number(el.dataset.dir);
      const value = Number(input.value.replace(/[,\s]/g, ''));
      if (el.dataset.step === 'as-price') {
        // Along EA's price grid, like the web app's own price arrows.
        if (!Number.isFinite(value)) return;
        input.value = String(Math.max(MIN_SALE_PRICE, stepPrice(value, dir)));
      } else if (el.dataset.step === 'as-steps') {
        if (!Number.isFinite(value)) return;
        input.value = signedSteps(Math.min(BOT_LIMITS.autoSellSteps.max, Math.max(BOT_LIMITS.autoSellSteps.min, Math.round(value) + dir)));
      } else {
        const step = (STEPS[el.dataset.step] ?? 1) * dir;
        const r = parseRange(input.value.replace(/[,\s]/g, ''), false);
        if (!r) return;
        const round = (v: number) => Math.max(0, Math.round(v * 100) / 100);
        input.value =
          r.min === r.max
            ? String(round(r.min + step))
            : `${round(r.min + step)}-${round(r.max + step)}`;
      }
      if (isModeField(el.dataset.step)) {
        const next = readModeSettings();
        if (next) commitMode(next, false);
      } else {
        const next = readSettings();
        if (next) commit(next, false);
      }
    } else if (el.dataset.asMode || el.dataset.asPlatform) {
      const s = shown();
      const autoSell = el.dataset.asMode
        ? { ...s.autoSell, mode: el.dataset.asMode === 'fixed' ? ('fixed' as const) : ('market' as const) }
        : { ...s.autoSell, platform: el.dataset.asPlatform === 'pc' ? ('pc' as const) : ('console' as const) };
      commit({ ...s, autoSell }, true);
    } else if (el.id === 'as-on' || el.id === 'as-noloss') {
      const s = shown();
      const a = s.autoSell;
      commit({ ...s, autoSell: el.id === 'as-on' ? { ...a, enabled: !a.enabled } : { ...a, noLoss: !a.noLoss } }, true);
    } else if (el.dataset.delay) {
      const min = Number(el.dataset.min);
      const max = Number(el.dataset.max);
      commit({ ...shown(), searchDelay: { min, max } }, true);
    } else if (el.id === 'reset-rec') {
      commit(withRecommendedLimits(shown()), true);
      say('Reset to recommended', false);
    } else if (el.id === 'preset-bursts') {
      commit(withShortBurstLimits(shown()), true);
      say(`Short bursts: ${SHORT_BURSTS_HINT}`, false);
    } else if (el.id === 'ack-confirm') {
      const check = root.getElementById('ack-check') as HTMLInputElement | null;
      if (!check?.checked) return;
      commit({ ...shown(), riskAcknowledgedAt: new Date().toISOString() }, true);
    } else if (el.id === 'b-on') {
      const s = shown();
      commit({ ...s, breaks: { ...s.breaks, enabled: !s.breaks.enabled } }, true);
    } else if (el.id === 'r-on') {
      const s = shown();
      commit({ ...s, rest: { ...s.rest, enabled: !s.rest.enabled } }, true);
    }
    // A toggle or preset inside <summary> must not also fold the card.
    if (el.closest('summary')) e.preventDefault();
  });

  onTrusted($('knobs'), 'change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id === 'ack-check') {
      ($('ack-confirm') as HTMLButtonElement).disabled = !input.checked;
      return;
    }
    if (!input.id) return;
    if (isModeField(input.id)) {
      const next = readModeSettings();
      if (next) commitMode(next, false);
      return;
    }
    const next = readSettings();
    if (next) commit(next, false);
  });

  // ---- Start bar ------------------------------------------------------------

  /** What the Snipe / Bid choice shows now, so a render that would write the
   * same buttons does nothing. */
  let modesShown = '';

  /** The Snipe / Bid choice beside Start. Locked while the bot runs: the
   * mode applies at Start. */
  function renderModes(running: boolean): void {
    const html = MODES.map(
      (m) =>
        `<button type="button" class="mode" role="radio" data-mode="${m.mode}" aria-checked="${modeSettings.mode === m.mode}"${
          running ? ' disabled' : ''
        } title="${esc(running ? 'Stop Nova AI to switch' : m.hint)}"><span>${esc(m.label)}</span> <small>${esc(m.hint)}</small></button>`,
    ).join('');
    $('settings').dataset.mode = modeSettings.mode;
    if (html === modesShown) return;
    modesShown = html;
    $('modes').innerHTML = html;
  }

  function renderRunbar(): void {
    const start = root.getElementById('start') as HTMLButtonElement | null;
    const status = root.getElementById('run-status');
    if (!start || !status) return;
    const sniper = deps.getSniper();
    const running = sniper?.isRunning() ?? false;
    renderModes(running);
    const r = currentSearch();
    let text: string;
    let bad = false;
    if (!sniper) {
      text = deps.getUnavailableReason() ?? 'Nova AI is not available right now.';
      bad = true;
    } else if (running && sniper.state.notice) {
      // An hourly limit holding buying back: which, and when it frees.
      text = sniper.state.notice;
      bad = true;
    } else if (running) {
      const startedAt = sniper.getStats().startedAt;
      text = `Running for ${clock(startedAt ? Date.now() - startedAt : 0)}`;
      const bids = sniper.getBidStatus();
      if (bids) text += ` · Active bids: ${bids.active}/${bids.max}`;
      if (sniper.getRunMode() === 'gallery') {
        const n = gallerySummary(currentGallery());
        text += ` · Gallery: ${n.total - n.todo} of ${n.total} done`;
      } else if ('error' in r) text += `. Search not updated: ${r.error}`;
    } else if (ackNeeded()) {
      text = 'Confirm the risk level on the Settings tab to start';
      bad = true;
    } else if (galleryMode()) {
      const g = currentGallery();
      const n = gallerySummary(g);
      if (n.todo === 0) {
        text = n.total === 0 ? 'Add fut.gg Sets, or paste your Gallery list and press Load list, to start' : 'Every card on your Gallery list is done';
        bad = true;
      } else if (g.budget - g.spent < MIN_SALE_PRICE) {
        text = 'Your Gallery budget is spent: raise it to start';
        bad = true;
      } else text = `Buys ${n.todo} Gallery ${n.todo === 1 ? 'card' : 'cards'} · ${fmt(g.budget - g.spent)} coins of budget left`;
    } else if ('error' in r) {
      text = r.error;
      bad = true;
    } else if (bidMode() && !hasMaxBid(r.search.filter)) {
      text = BID_NEEDS_MAX;
      bad = true;
    } else {
      text = `${bidMode() ? 'Bids on' : 'Searches for'} ${r.search.name}`;
    }
    const label = running ? 'Stop' : 'Start';
    if (start.dataset.label !== label) {
      start.dataset.label = label;
      start.innerHTML = `${running ? STOP : PLAY}<span>${label}</span>`;
    }
    start.classList.toggle('stop', running);
    start.disabled = !sniper || (!running && ackNeeded());
    start.title = start.disabled ? text : '';
    status.textContent = text;
    status.title = text;
    status.classList.toggle('bad', bad);
    status.classList.toggle('wrap', running && !!sniper?.state.notice);
    // Start waits on the risk confirmation, which is on the Settings tab:
    // the line saying so takes the user there.
    status.classList.toggle('go', !running && !!sniper && ackNeeded());
  }

  // ---- live side ----------------------------------------------------------

  function nameOf(resourceId: number | undefined): string {
    if (resourceId == null) return '';
    const n = names.get(resourceId);
    return n ?? `#${resourceId}`;
  }

  function wantNames(ids: (number | undefined)[]): void {
    const missing = [...new Set(ids.filter((id): id is number => id != null && !names.has(id)))];
    if (missing.length === 0) return;
    for (const id of missing) names.set(id, null);
    void deps.resolveNames(missing.slice(0, 50)).then((found) => {
      let changed = false;
      for (const [id, name] of Object.entries(found)) {
        if (name) {
          names.set(Number(id), name);
          changed = true;
        }
      }
      if (changed) queueRefresh();
    });
  }

  /** Replaces an element's markup only when it changed: a refresh comes
   * several times a search, and rebuilding what did not change is work done
   * on the same thread that draws the countdown. */
  const shownHtml = new WeakMap<HTMLElement, string>();
  function setHtml(el: HTMLElement | null, html: string): void {
    if (el && shownHtml.get(el) !== html) {
      shownHtml.set(el, html);
      el.innerHTML = html;
    }
  }

  /** What the transfer list figures show now, so a render that would write
   * the same figures does nothing. */
  let tlShown = '';
  /** The Transfer list card's button at work (`transferTools`): what the
   * card says meanwhile, or null when none is. */
  let tlBusy: string | null = null;
  /** What the last button press did, for the card. */
  let tlResult: { ok: boolean; message: string } | null = null;

  /** The dash is built once, with the ring in it, and updated in place. */
  function buildDash(): void {
    $('dash').innerHTML = `
      <div class="tile profit"><div class="v" id="d-profit"></div><div class="k">Profit</div></div>
      <div class="tile searches"><div class="v" id="d-searches"></div><div class="k">Searches</div></div>
      <div class="panelbox top-snipes"><h3>Top snipes</h3><div id="d-top"></div></div>
      <div class="counters">
        <div class="counter c-green"><span>Bought</span><span class="n" id="d-bought"></span></div>
        <div class="counter c-red"><span>Missed</span><span class="n" id="d-missed"></span></div>
        <div class="counter c-blue"><span>Coins spent</span><span class="n" id="d-spent"></span></div>
        <div class="counter c-yellow" id="d-sold-row" title="${esc(TL_WAITING)}"><span>Sold</span><span class="n na" id="d-sold">—</span></div>
        <div class="counter c-orange" id="d-unsold-row" title="${esc(TL_WAITING)}"><span>Unsold</span><span class="n na" id="d-unsold">—</span></div>
      </div>
      <div class="panelbox ring-box" id="ringbox"></div>
      <div class="panelbox tl" id="d-tl" title="${esc(TL_WAITING)}">
        <div class="hd"><span>Transfer list</span>${
          deps.transferTools
            ? `<button type="button" class="tl-btn" id="d-tl-clear" title="Take the sold cards off your transfer list (EA's Clear Sold)" disabled>Clear sold</button>`
            : ''
        }</div>
        <div class="big na" id="d-tl-big"><span id="d-tl-n">—</span> <span class="of">/${TRANSFER_LIST_SIZE}</span></div>
        <div class="bar"><i id="d-tl-bar" style="width:0%"></i></div>
        <div class="sub" id="d-tl-sub"></div>
        ${
          deps.transferTools
            ? `<div class="relist" id="d-tl-relist">Relist unsold<div class="steps">${RELIST_CHOICES.map(
                (c) => `<button type="button" class="tl-btn" data-step="${c.step}" title="${esc(c.title)}" disabled>${c.label}</button>`,
              ).join('')}</div></div>
        <div class="msg" id="d-tl-msg"></div>`
            : ''
        }
      </div>
    `;
    $('ringbox').append(ring.el);
    if (deps.transferTools) wireTransferTools(deps.transferTools);
    // Fresh elements: the next render writes the transfer list figures.
    tlShown = '';
  }

  /** The Sold and Unsold counters and the Transfer list panel, from the
   * transfer list as EA's page last showed it. Runs on every refresh and
   * every second while the page is open, so it returns at once unless the
   * figures changed. */
  function renderTransferList(): void {
    const s = deps.getTransferList?.() ?? null;
    const key = `${s ? `${s.total}/${s.sold}/${s.soldCleared}/${s.unsold}/${s.listed}/${s.unlisted}/${s.seenAt}` : 'none'}|${tlBusy ?? ''}|${tlResult?.message ?? ''}`;
    if (key === tlShown || !root.getElementById('d-tl')) return;
    tlShown = key;
    const title = s ? `Your Transfer List as EA last showed it, at ${timeOfDay(s.seenAt)}` : TL_WAITING;
    for (const id of ['d-unsold-row', 'd-tl']) $(id).title = title;
    $('d-sold-row').title = s ? `${title}, with the sold cards cleared off it since this page opened` : title;
    for (const id of ['d-sold', 'd-unsold', 'd-tl-big']) $(id).classList.toggle('na', !s);
    // Clearing the sold cards off the list never takes them off this count.
    setText($('d-sold'), s ? fmt(s.sold + s.soldCleared) : '—');
    setText($('d-unsold'), s ? fmt(s.unsold) : '—');
    setText($('d-tl-n'), s ? fmt(s.total) : '—');
    // The bar stops at a full list, even if a count kept up from partial
    // responses runs over (a card that left the list unseen).
    $('d-tl-bar').style.width = `${s ? Math.min(100, (s.total / TRANSFER_LIST_SIZE) * 100) : 0}%`;
    setText($('d-tl-sub'), s ? transferListBreakdown(s) : '');
    if (!deps.transferTools) return;
    // A button works only on what the list has, and one at a time.
    $<HTMLButtonElement>('d-tl-clear').disabled = !!tlBusy || !s || s.sold === 0;
    for (const b of $('d-tl-relist').querySelectorAll('button')) b.disabled = !!tlBusy || !s || s.unsold === 0;
    const msg = $('d-tl-msg');
    setText(msg, tlBusy ?? tlResult?.message ?? '');
    msg.classList.toggle('bad', !tlBusy && tlResult?.ok === false);
  }

  /** The Transfer list card's buttons: each runs to its end before another
   * can start, and the card says what it did. */
  function wireTransferTools(tools: NonNullable<BotPageDeps['transferTools']>): void {
    const run = (busy: string, work: () => Promise<{ ok: boolean; message: string }>) => {
      if (tlBusy) return;
      tlBusy = busy;
      tlResult = null;
      renderTransferList();
      void work()
        .catch((err: unknown) => ({ ok: false, message: `Something went wrong: ${String(err)}` }))
        .then((result) => {
          tlBusy = null;
          tlResult = result;
          renderTransferList();
        });
    };
    onTrusted($('d-tl-clear'), 'click', () => run('Clearing the sold cards…', () => tools.clearSold()));
    for (const b of $('d-tl-relist').querySelectorAll('button')) {
      const step = Number(b.dataset.step) as -1 | 0 | 1;
      onTrusted(b, 'click', () =>
        run('Relisting the unsold cards…', () =>
          tools.relist(step, (done, total) => {
            tlBusy = `Relisting ${done} of ${total}…`;
            renderTransferList();
          }),
        ),
      );
    }
  }

  /** What the cards on the list are, adding up to its total: listed and
   * not listed always, sold and unsold (sitting there until cleared) when
   * there are any. */
  function transferListBreakdown(s: TransferListSummary): string {
    const parts = [`${fmt(s.listed)} listed`];
    if (s.sold > 0) parts.push(`${fmt(s.sold)} sold`);
    if (s.unsold > 0) parts.push(`${fmt(s.unsold)} unsold`);
    parts.push(`${fmt(s.unlisted)} not listed`);
    return parts.join(' · ');
  }

  function renderDash(): void {
    if (!root.getElementById('ringbox')) buildDash();
    const sniper = deps.getSniper();
    const stats = sniper?.getStats();
    const top = stats?.topSnipes ?? [];
    wantNames(top.map((t) => t.assetId ?? t.resourceId));
    setHtml($('d-profit'), `${fmt(stats?.profit ?? 0)}${COIN}`);
    setText($('d-searches'), fmt(stats?.searches ?? 0));
    setHtml(
      $('d-top'),
      top.length === 0
        ? '<div class="empty" style="padding:6px">No snipes yet</div>'
        : top
            .map(
              (t) =>
                `<div class="ts-row"><span>${esc(nameOf(t.assetId ?? t.resourceId))}</span><span>${fmt(t.profit ?? 0)}${COIN}</span></div>`,
            )
            .join(''),
    );
    setText($('d-bought'), fmt(stats?.purchases ?? 0));
    setText($('d-missed'), fmt(stats?.failures ?? 0));
    setText($('d-spent'), fmt(stats?.coinsSpent ?? 0));
    renderTransferList();
    renderRing();
  }

  // ---- the countdown ring -------------------------------------------------
  //
  // Built once. The arc is two half rings, each rotated out of its half of
  // the circle: the left one during the first half of the wait, the right
  // one during the second. Both rotations are handed to the browser (the
  // Web Animations API) when the wait starts, and only `transform` animates,
  // which the browser runs on its compositor thread: the arc keeps moving
  // smoothly even while EA's page keeps the main thread busy (an animated
  // SVG stroke runs on the main thread, and stuttered with it). Without that
  // API (tests), the arc is set every frame instead. The text is updated
  // every frame, written only when it changes.
  const ring = (() => {
    const el = document.createElement('div');
    el.className = 'ring-wrap';
    el.innerHTML = `
      <div class="ring" aria-hidden="true">
        <div class="ring-track"></div>
        <div class="ring-half ring-r"><div class="ring-fill"></div></div>
        <div class="ring-half ring-l"><div class="ring-fill"></div></div>
      </div>
      <div class="ring-label"><div class="t">0s</div><div class="p"></div></div>
      <div class="elapsed">Running for<b>0:00</b></div>`;
    return {
      el,
      left: el.querySelector('.ring-l .ring-fill') as HTMLElement,
      right: el.querySelector('.ring-r .ring-fill') as HTMLElement,
      time: el.querySelector('.ring-label .t') as HTMLElement,
      phase: el.querySelector('.ring-label .p') as HTMLElement,
      elapsed: el.querySelector('.elapsed b') as HTMLElement,
      /** The wait the arc is counting down, and how long it was. */
      endsAt: null as number | null,
      total: 0,
      shown: '',
      anims: [] as Animation[],
    };
  })();

  /** The arc at `fraction` of the wait left (1 full, 0 empty), set directly:
   * between waits, and where the page has no Web Animations API. */
  function setArc(fraction: number): void {
    const spent = 1 - Math.min(1, Math.max(0, fraction));
    const left = -180 * Math.min(1, spent * 2);
    const right = -180 * Math.max(0, spent * 2 - 1);
    const key = `${left.toFixed(2)}/${right.toFixed(2)}`;
    if (key === ring.shown) return;
    ring.shown = key;
    ring.left.style.transform = `rotate(${left.toFixed(2)}deg)`;
    ring.right.style.transform = `rotate(${right.toFixed(2)}deg)`;
  }

  /** A new wait (or none): the arc starts full and empties as it runs out. */
  function startArc(remaining: number): void {
    for (const a of ring.anims) a.cancel();
    ring.anims = [];
    setArc(remaining > 0 ? 1 : 0);
    if (remaining <= 0 || typeof ring.left.animate !== 'function') return;
    const half = remaining / 2;
    const turn = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-180deg)' }];
    ring.anims = [
      ring.left.animate(turn, { duration: half, easing: 'linear', fill: 'forwards' }),
      ring.right.animate(turn, { duration: half, delay: half, easing: 'linear', fill: 'both' }),
    ];
  }

  function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  function renderRing(): void {
    const sniper = deps.getSniper();
    const state = sniper?.state;
    const now = Date.now();
    const endsAt = state?.phaseEndsAt ?? null;
    const remaining = endsAt ? Math.max(0, endsAt - now) : 0;
    if (endsAt !== ring.endsAt) {
      ring.endsAt = endsAt;
      ring.total = remaining;
      startArc(remaining);
    }
    if (ring.anims.length === 0) setArc(remaining > 0 && ring.total > 0 ? remaining / ring.total : 0);
    const secs = remaining / 1000;
    setText(ring.time, remaining > 0 ? (secs >= 60 ? clock(remaining) : `${Math.ceil(secs)}s`) : '0s');
    setText(ring.phase, PHASE_LABEL[state?.phase ?? 'idle']);
    const startedAt = sniper?.getStats().startedAt;
    setText(ring.elapsed, clock(startedAt ? now - startedAt : 0));
  }

  /** One frame: the ring, and the run bar's clock once a second. */
  let runClock = '';
  /** Whether anything on the ring is moving: the bot is running, or a phase
   * countdown is still in the future. Only then does the panel do per-frame
   * work — idle, it does none, so opening it, scrolling and changing settings
   * stay smooth. */
  function ringLive(): boolean {
    const sniper = deps.getSniper();
    if (sniper?.isRunning()) return true;
    const ends = sniper?.state?.phaseEndsAt ?? null;
    return ends != null && ends > Date.now();
  }

  function animate(): void {
    renderRing();
    const sniper = deps.getSniper();
    const startedAt = sniper?.getStats().startedAt;
    const c = sniper?.isRunning() && startedAt ? clock(Date.now() - startedAt) : '';
    if (c !== runClock) {
      runClock = c;
      renderTop();
    }
    ringFrame = ringLive() && !page.hidden ? requestAnimationFrame(animate) : null;
  }

  /** A buy's (or a won auction's) estimated profit, as a pill. */
  function profitPill(e: SniperLogEntry): string {
    return e.profit == null
      ? ''
      : `<span class="pill ${e.profit < 0 ? 'neg' : ''}">${e.profit >= 0 ? '+' : ''}${fmt(e.profit)}${COIN}</span>`;
  }

  function logHtml(e: SniperLogEntry): string {
    const when = timeOfDay(e.at);
    const who = `${e.rating ?? ''} ${esc(nameOf(e.assetId ?? e.resourceId))}`.trim();
    // A note can name its card too (Gallery mode's): its name goes where `{card}` is.
    if (e.kind === 'info')
      return `<div class="log"><div class="main">${esc(e.message).replace('{card}', `<b>${who}</b>`)}<div class="sub">${when}</div></div></div>`;
    // How fast the bot went for it, from the listing arriving to the buy.
    const reacted = e.reactionMs != null ? `, reacted in ${fmt(e.reactionMs)} ms` : '';
    // Bid mode's lines name the card inside the sentence ("Bid 12,250 on
    // {card} (3 min left)"): its name goes where `{card}` is.
    if (e.message.includes('{card}')) {
      const sells = e.kind === 'won' && e.sellPrice != null ? `, sells for <span class="amt">${fmt(e.sellPrice)}${COIN}</span>` : '';
      return `<div class="log ${e.kind}"><div class="main">${esc(e.message).replace('{card}', `<b>${who}</b>`)}
        <div class="sub">${when}${sells}${e.detail ? `, ${esc(e.detail)}` : ''}</div></div>${e.kind === 'won' ? profitPill(e) : ''}</div>`;
    }
    if (e.kind === 'bought') {
      return `<div class="log bought"><div class="main"><b>${who}</b> bought for <span class="amt">${fmt(e.price ?? 0)}${COIN}</span>
        <div class="sub">${when}${e.sellPrice != null ? `, sells for <span class="amt">${fmt(e.sellPrice)}${COIN}</span>` : ''}${reacted}</div></div>${profitPill(e)}</div>`;
    }
    if (e.kind === 'listed') {
      return `<div class="log listed"><div class="main"><b>${who}</b> listed for <span class="amt">${fmt(e.price ?? 0)}${COIN}</span>
        <div class="sub">${when}, ${esc(e.message)}</div></div></div>`;
    }
    if (e.kind === 'failed') {
      return `<div class="log failed"><div class="main">${e.resourceId != null ? `<b>${who}</b> missed at <span class="amt">${fmt(e.price ?? 0)}${COIN}</span>` : esc(e.message)}
        <div class="sub">${when}${e.resourceId != null ? `, ${esc(e.message)}` : ''}${reacted}</div></div></div>`;
    }
    return `<div class="log blocked"><div class="main">${e.resourceId != null ? `<b>${who}</b> ` : ''}${esc(e.message)}<div class="sub">${when}</div></div></div>`;
  }

  function resultHtml(r: SniperSearchResult): string {
    const when = timeOfDay(r.at);
    if (r.matches.length === 0) {
      const seen =
        r.listings == null
          ? ''
          : r.listings === 0
            ? ', nothing listed at your price'
            : `, ${r.listings} listed${r.cheapest != null ? `, cheapest ${fmt(r.cheapest)}` : ''}`;
      return `<div class="res"><span class="when">${when}</span>No matches${esc(seen)}</div>`;
    }
    const rows = r.matches
      .map(
        (m) =>
          `<div class="res item"><span>${m.rating} ${esc(nameOf(m.assetId))}</span><span>${
            m.outbid === 'rebid' ? 're-bid ' : m.outbid === 'over_max' ? 'next bid ' : m.bid != null ? 'bid ' : ''
          }${fmt(m.bid ?? m.buyNow)}${COIN}${
            m.bid != null && m.currentBid != null ? (m.currentBid > 0 ? ` (now ${fmt(m.currentBid)})` : ' (start)') : ''
          }${m.outbid === 'over_max' ? ', over your max' : ''}${
            m.expiresAt ? `, ${clock(m.expiresAt - r.at)} left` : ''
          }</span></div>`,
      )
      .join('');
    // Bid mode: an auction the trader lost the lead on (Sniper.showOutbid).
    const outbid = r.matches[0]?.outbid;
    const head =
      outbid === 'rebid'
        ? 'Outbid: you lost the lead, re-bidding'
        : outbid === 'over_max'
          ? 'Outbid: the next bid is over your max, dropping it'
          : `Found ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}`;
    return `<div class="res"><span class="when">${when}</span>${head}</div>${rows}`;
  }

  function renderFeeds(): void {
    const sniper = deps.getSniper();
    const log = sniper?.getLog() ?? [];
    const results = sniper?.getSearchResults() ?? [];
    wantNames([
      ...log.map((e) => e.assetId ?? e.resourceId),
      ...results.flatMap((r) => r.matches.map((m) => m.assetId)),
    ]);
    setHtml(
      $('log'),
      log.length === 0
        ? '<div class="empty">Purchases and events appear here once Nova AI is running.</div>'
        : log.map(logHtml).join(''),
    );
    setHtml(
      $('results'),
      results.length === 0 ? '<div class="empty">Each search appears here.</div>' : results.map(resultHtml).join(''),
    );
    renderBids();
  }

  /** The tab beside Search results the trader picked; until they pick one,
   * Active bids in Bid mode, the Gallery list in Gallery mode and Search
   * results in Snipe mode. */
  let feedTab: 'results' | 'bids' | 'gallery' | null = null;

  /** The Gallery feed's last-drawn signature: its rows cost real work to
   * build and the feed can run to hundreds of cards, but the list only
   * changes on a buy or a status change — not on the per-second bids tick or
   * every search frame. So the feed is rebuilt only when this cheap signature
   * (each card's status in order, the card being bought, spend and completed
   * Sets) changes, which is what stops the panel juddering while the bot
   * runs. The feed draws from each card's own name, so it never waits on the
   * async name lookup the log and results feeds use. */
  let gallerySig = '';

  /** The cheap signature the Gallery feed is memoised on. */
  function gallerySignature(g: GalleryState, running: boolean): string {
    const buying = running ? (g.cards.find((c) => c.status === 'todo' && galleryCardNeeded(c, g))?.key ?? '') : '';
    let statuses = '';
    for (const c of g.cards) statuses += c.status[0];
    return `${running ? 1 : 0}|${g.spent}|${g.cards.length}|${buying}|${(g.completed ?? []).join(',')}|${statuses}`;
  }

  /** Bid mode's open bids (`Sniper.getActiveBids`): where each stands and
   * how long it has left, redrawn every second while the page is open. In
   * Gallery mode, its list's cards and where each one is. */
  function renderBids(): void {
    const sniper = deps.getSniper();
    root.querySelector<HTMLElement>('.ftab[data-feed="gallery"]')!.hidden = !galleryMode();
    const picked = feedTab === 'gallery' && !galleryMode() ? null : feedTab;
    const tab = picked ?? (galleryMode() ? 'gallery' : bidMode() ? 'bids' : 'results');
    for (const el of root.querySelectorAll<HTMLElement>('.ftab')) el.setAttribute('aria-selected', String(el.dataset.feed === tab));
    $('results').hidden = tab !== 'results';
    $('bids').hidden = tab !== 'bids';
    $('gallery-feed').hidden = tab !== 'gallery';
    root.querySelector('.feeds')!.classList.toggle('bids-open', tab === 'bids' || tab === 'gallery');
    if (galleryMode()) {
      const g = currentGallery();
      const n = gallerySummary(g);
      const count = n.total > 0 ? `${n.total - n.todo}/${n.total}` : '';
      const countEl = $('gallery-count');
      if (countEl.textContent !== count) countEl.textContent = count;
      const sum = root.getElementById('g-sum');
      if (sum && sum.textContent !== gallerySumText(g)) sum.textContent = gallerySumText(g);
      if (tab === 'gallery') {
        const running = sniper?.isRunning() ?? false;
        const sig = gallerySignature(g, running);
        if (sig !== gallerySig) {
          gallerySig = sig;
          setHtml($('gallery-feed'), galleryFeedHtml(g, running));
        }
      }
    }
    const view = sniper?.getActiveBids() ?? null;
    const count = view && view.bids.length > 0 ? `${view.bids.length}/${view.max}` : '';
    const countEl = $('bids-count');
    if (countEl.textContent !== count) countEl.textContent = count;
    if (tab !== 'bids') return;
    wantNames(view?.bids.map((b) => b.assetId) ?? []);
    setHtml($('bids'), bidsHtml(view, sniper?.isRunning() ?? false, Date.now()));
  }

  function bidsHtml(view: ReturnType<Sniper['getActiveBids']> | null, running: boolean, now: number): string {
    if (!view || view.bids.length === 0) {
      return running && bidMode()
        ? '<div class="empty">No open bids right now: Nova AI is looking for auctions to bid on.</div>'
        : '<div class="empty">Your open bids appear here while Bid mode runs: your bid, the current bid, whether you lead, and the time left.</div>';
    }
    let leading = 0;
    let outbid = 0;
    let waiting = 0;
    let held = 0;
    for (const b of view.bids) {
      if (b.state === 'leading') leading++;
      else if (b.state === 'outbid') outbid++;
      else waiting++;
      if (b.state !== 'outbid') held += b.amount;
    }
    const parts = [`<b>${view.bids.length} of ${view.max}</b> open`, `${leading} leading`];
    if (outbid > 0) parts.push(`${outbid} outbid`);
    if (waiting > 0) parts.push(`${waiting} waiting for EA`);
    parts.push(`${fmt(held)}${COIN} held`);
    const checked = !running
      ? 'not checked while Nova AI is stopped: EA keeps these bids'
      : view.checkedAt == null
        ? 'not checked yet'
        : `checked ${Math.max(0, Math.round((now - view.checkedAt) / 1000))} s ago${view.stale ? ' · EA answered from its cache, so these may be out of date' : ''}`;
    return `<div class="bids-head">${parts.join(' · ')} · <span class="when">${checked}</span></div>${view.bids.map((b) => bidRowHtml(b, now)).join('')}`;
  }

  function galleryFeedHtml(g: GalleryState, running: boolean): string {
    if (g.cards.length === 0) return '<div class="empty">Paste your Gallery list on the left, then press Load list, or add fut.gg Sets.</div>';
    // The bot works the list in order: the first card still to buy is the one it is on.
    const buying = running ? g.cards.find((c) => c.status === 'todo' && galleryCardNeeded(c, g))?.key : undefined;
    const completed = new Set(g.completed ?? []);
    // Each fut.gg Set: the grade its lineup is for, and how far it got.
    const sets = gallerySetProgress(g)
      .map((p) => {
        if (completed.has(p.set.id))
          return `<div class="g-sethead done"><b>${esc(p.set.name)}</b> · grade ${p.set.grade} · completed${completedWhen(g, p.set.id)} ✓ · ${p.done} of ${p.cards} collected</div>`;
        const risk =
          p.skipped > 0
            ? ` · <span class="warn">${p.skipped} skipped (${fmt(p.skippedScore)} points): retry ${p.skipped === 1 ? 'it' : 'them'}, or the Set may miss grade ${p.set.grade}</span>`
            : '';
        const note = blockerNote(gallerySetBlockers(g, p.set.id));
        const why = note ? ` · <span class="g-why" title="${esc(note.detail)}">not done: ${esc(note.summary)}</span>` : '';
        return `<div class="g-sethead"><b>${esc(p.set.name)}</b> · grade ${p.set.grade} needs ${fmt(p.set.threshold)} points, the lineup makes ${fmt(p.set.score)} · ${p.done} of ${p.cards} collected${risk}${why}</div>`;
      })
      .join('');
    // Still to buy first; cards on their way, then the done ones, after.
    const groups: { title: string; cards: GalleryCard[] }[] = [
      { title: 'To buy', cards: g.cards.filter((c) => c.status === 'todo' && galleryCardNeeded(c, g)) },
      { title: 'On the way to the market', cards: g.cards.filter((c) => c.status === 'bought' || c.status === 'club') },
      { title: 'SBC/Objective — collect in the game', cards: g.cards.filter((c) => c.status === 'sbc') },
      { title: 'Skipped', cards: g.cards.filter((c) => c.status === 'skipped') },
      { title: 'Done', cards: g.cards.filter((c) => c.status === 'listed' || c.status === 'owned' || (c.status === 'todo' && !galleryCardNeeded(c, g))) },
    ];
    const rows = groups
      .filter((x) => x.cards.length > 0)
      .map((x) => {
        // A long list (hundreds of cards over many Sets) is capped so the feed
        // stays quick to scroll and to redraw; the group header keeps the true
        // count. The card Nova is on is the first still to buy, so it is shown.
        const shown = x.cards.slice(0, GALLERY_FEED_GROUP_MAX);
        const more = x.cards.length - shown.length;
        const body = shown.map((c) => galleryRowHtml(c, c.key === buying, running, g)).join('');
        const extra = more > 0 ? `<div class="g-more">+${fmt(more)} more</div>` : '';
        return `<div class="g-group">${esc(x.title)} · ${fmt(x.cards.length)}</div>${body}${extra}`;
      })
      .join('');
    return `<div class="bids-head">${esc(gallerySumText(g))}</div>${sets}${rows}`;
  }

  function galleryRowHtml(c: GalleryCard, buying: boolean, running: boolean, g: GalleryState): string {
    const parked = c.status === 'todo' && !galleryCardNeeded(c, g);
    const state = buying ? 'buying' : parked ? 'listed' : c.status;
    const label = buying ? 'Buying now' : parked ? 'Set completed' : GALLERY_STATUS[c.status];
    const detail = c.note ?? (c.market != null ? `Market price ${fmt(c.market)}` : c.guide != null ? `fut.gg price ${fmt(c.guide)}` : null);
    const sub = [c.set, detail].filter((x): x is string => !!x).map(esc).join(' · ');
    const paid = c.price != null ? `${fmt(c.price)}${COIN}` : '—';
    const listed = c.listPrice != null ? `${fmt(c.listPrice)}${COIN}` : '—';
    const version = c.version ? ` <span class="sub">${esc(c.version)}</span>` : '';
    // A card bought but not on the market (the bot stopped, or the page
    // reloaded): the trader can say they listed it.
    const handled =
      !running && (c.status === 'bought' || c.status === 'club')
        ? `<button type="button" class="g-link" data-handled="${esc(c.key)}">Listed it myself</button>`
        : '';
    return `<div class="bidrow ${state}"><div class="main"><b>${c.rating} ${esc(c.name)}</b>${version}<span class="st ${state}">${label}</span>
      <div class="sub">${sub}${handled ? ` · ${handled}` : ''}</div></div>
      <div class="cur"><span class="k">Paid</span><span class="v">${paid}</span></div>
      <div class="cur"><span class="k">Listed at</span><span class="v">${listed}</span></div></div>`;
  }

  function bidRowHtml(b: ActiveBid, now: number): string {
    const left = b.expiresAt - now;
    // Ended and still leading: won unless a last-second bid came in, which
    // the check that runs right after its end says.
    const label = b.state === 'leading' ? (left > 0 ? 'Leading' : 'Ended, confirming') : b.state === 'outbid' ? 'Outbid' : 'Waiting for EA';
    const max = `max ${fmt(b.maxBid)}${COIN}`;
    const sub =
      b.state === 'leading'
        ? `Your bid is the highest · ${max}`
        : b.state === 'outbid'
          ? b.overMax
            ? `Next bid ${fmt(b.nextBid)}${COIN} is over your ${max}`
            : `Your bid ${fmt(b.amount)}${COIN} · re-bidding ${fmt(b.nextBid)}${COIN} · ${max}`
          : `Your bid ${fmt(b.amount)}${COIN} · the next check says if it leads · ${max}`;
    const time = left > 0 ? clock(left) : 'ended';
    const timeCls = left <= 30_000 ? 'left now' : left <= 60_000 ? 'left soon' : 'left';
    return `<div class="bidrow ${b.state}"><div class="main"><b>${b.rating} ${esc(nameOf(b.assetId))}</b><span class="st ${b.state}">${label}</span>
      <div class="sub">${sub}</div></div>
      <div class="cur"><span class="k">Current bid</span><span class="v">${b.currentBid > 0 ? `${fmt(b.currentBid)}${COIN}` : '—'}</span></div>
      <div class="${timeCls}"><span class="k">Left</span><span class="v">${time}</span></div></div>`;
  }

  function renderTop(): void {
    const sniper = deps.getSniper();
    const state = sniper?.state;
    const running = sniper?.isRunning() ?? false;
    const phase = $('phase');
    phase.textContent =
      state?.phase === 'stopped' && state.stopDetail
        ? `Stopped: ${state.stopDetail}`
        : running && state?.notice
          ? state.notice.startsWith('Bidding paused')
            ? 'Bidding paused'
            : 'Buying paused'
          : PHASE_LABEL[state?.phase ?? 'idle'];
    phase.title = running ? (state?.notice ?? '') : '';
    phase.className = `chip ${running ? 'running' : state?.phase === 'stopped' ? 'stopped' : ''}`;
    renderRunbar();
    $<HTMLButtonElement>('reset').disabled = !sniper || running;
    const notice = $('notice');
    notice.hidden = !!sniper;
    notice.textContent = deps.getUnavailableReason() ?? '';
  }

  /** The trader's coins and FC Points, as EA's top bar shows them
   * (ui/ea-wallet.ts): the page covers that bar. Each shows once it can be
   * read. */
  /** The coins to show: the balance EA's last response stated, unless
   * EA's top bar has changed since it arrived (a pack bought by hand, say),
   * which makes the bar the newer one. */
  let creditsAt = 0;
  let barAtCredits: number | null = null;
  function walletCoins(bar: number | null): number | null {
    const c = deps.getCredits?.() ?? null;
    if (!c) return bar;
    if (c.at !== creditsAt) {
      creditsAt = c.at;
      barAtCredits = bar;
    }
    return bar !== barAtCredits ? bar : c.credits;
  }

  function renderWallet(): void {
    const w = readWallet(doc);
    const coins = walletCoins(w.coins);
    for (const [id, value] of [
      ['w-coins', coins],
      ['w-points', w.points],
    ] as const) {
      const el = $(id);
      el.hidden = value == null;
      const text = value == null ? '' : fmt(value);
      const amt = el.querySelector('.amt')!;
      if (amt.textContent !== text) amt.textContent = text;
    }
    $('wallet').hidden = coins == null && w.points == null;
  }

  /** Whether the Gallery box was last drawn with the bot running (its
   * fields are locked while it runs). */
  let galleryDrawnRunning = false;

  function refreshLive(): void {
    renderTop();
    renderWallet();
    renderDash();
    renderFeeds();
    const running = deps.getSniper()?.isRunning() ?? false;
    if (running !== galleryDrawnRunning) {
      galleryDrawnRunning = running;
      renderGallery();
    }
    // The ring is static while idle, so redraw it here (once per change)
    // rather than every frame; and (re)start the per-frame loop only when
    // something is actually moving (the bot is running or a phase is counting
    // down).
    renderRing();
    if (ringLive() && ringFrame == null && !page.hidden) ringFrame = requestAnimationFrame(animate);
  }

  function queueRefresh(): void {
    if (refreshQueued || page.hidden) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refreshLive();
    });
  }

  onTrusted($('start'), 'click', () => {
    const sniper = deps.getSniper();
    if (!sniper) return;
    if (sniper.isRunning()) sniper.stop('manual');
    else if (ackNeeded()) {
      say('Confirm the risk level (or reset to recommended) to start');
      return;
    } else if (galleryMode()) {
      // Gallery mode works through its list: the search form plays no part.
      sniper.setSettings(settings);
      sniper.setModeSettings(modeSettings);
      sniper.start();
    } else {
      const r = currentSearch();
      if ('error' in r) {
        say(r.error);
        renderRunbar();
        return;
      }
      if (bidMode() && !hasMaxBid(r.search.filter)) {
        say(BID_NEEDS_MAX);
        renderRunbar();
        return;
      }
      deps.setLiveSearch(r.search);
      sniper.setSettings(settings);
      sniper.setModeSettings(modeSettings);
      sniper.start();
      if (sniper.isRunning()) rememberSearch(r.search.name);
    }
    refreshLive();
  });
  onTrusted($('reset'), 'click', () => {
    const sniper = deps.getSniper();
    sniper?.reset();
    // A fresh start for the Gallery list too: its finished cards and
    // completed Sets go (they stay marked completed), and spent goes to 0.
    const g = currentGallery();
    if (sniper && !sniper.isRunning() && (g.cards.length > 0 || g.spent > 0)) {
      const next = clearFinishedGallery(g);
      const gone = g.cards.length - next.cards.length;
      commitGallery(next, gone > 0 ? `Stats reset · ${gone} finished Gallery ${gone === 1 ? 'card' : 'cards'} cleared` : 'Stats reset');
    }
    refreshLive();
  });
  // EA's Reset, beside the Start button: empties the whole search.
  onTrusted($('nf-reset'), 'click', () => {
    form = blankForm();
    openDd = null;
    showTab('search');
    renderTargets();
  });
  onTrusted($('run-status'), 'click', () => {
    if ($('run-status').classList.contains('go')) showTab('settings');
  });
  // Snipe or Bid: saved at once, applied at the next Start.
  onTrusted($('modes'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    const mode = el?.dataset.mode;
    if (!el || el.disabled || (mode !== 'snipe' && mode !== 'bid' && mode !== 'gallery') || mode === modeSettings.mode) return;
    if (deps.getSniper()?.isRunning()) return;
    commitMode({ ...modeSettings, mode }, true);
  });
  onTrusted(root.querySelector('.tabs')!, 'click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (tab === 'search' || tab === 'settings') showTab(tab);
  });
  onTrusted(root.querySelector('.feed-tabs')!, 'click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-feed]')?.dataset.feed;
    if (tab !== 'results' && tab !== 'bids' && tab !== 'gallery') return;
    feedTab = tab;
    renderBids();
  });
  // The Gallery tab: a card bought but not listed by Nova, listed by hand.
  onTrusted($('gallery-feed'), 'click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-handled]')?.dataset.handled;
    if (!key || deps.getSniper()?.isRunning()) return;
    const g = currentGallery();
    const cards = g.cards.map((c) => {
      if (c.key !== key || (c.status !== 'bought' && c.status !== 'club')) return c;
      const { tradeId: _gone, ...rest } = c;
      return { ...rest, status: 'listed' as const, note: 'Listed by hand' };
    });
    const next = { ...g, cards };
    markCompletedSets(next);
    commitGallery(next, 'Marked as listed');
  });
  // Gallery mode's list box, its buttons and its budget.
  onTrusted($('gallery'), 'click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLButtonElement>('button[id^="g-"]')?.id;
    if (id) onGalleryClick(id);
    const target = e.target as HTMLElement;
    // Upgrade a completed Set to the higher grade fut.gg now lists (reusing the
    // cards already owned): a look-and-add, so it is blocked while the bot runs.
    const upgrade = Number(target.closest<HTMLButtonElement>('button[data-upgrade]')?.dataset.upgrade);
    if (Number.isInteger(upgrade) && upgrade > 0 && !deps.getSniper()?.isRunning()) {
      void upgradeFutggSet(upgrade);
      return;
    }
    // Add a Set at its best fully-buyable grade (no SBC/Objective cards):
    // a look-and-add, so it is blocked while the bot runs.
    const buyable = Number(target.closest<HTMLButtonElement>('button[data-buyable]')?.dataset.buyable);
    if (Number.isInteger(buyable) && buyable > 0 && !deps.getSniper()?.isRunning()) {
      void addBuyableFutggSet(buyable);
      return;
    }
    // Drop a stuck Set to a chosen lower grade ("<setId>:<grade>"): re-plans
    // the lineup at that grade, reusing owned cards. Blocked while the bot runs.
    const switchGrade = target.closest<HTMLButtonElement>('button[data-switch-grade]')?.dataset.switchGrade;
    if (switchGrade && !deps.getSniper()?.isRunning()) {
      const [idPart, gradePart] = switchGrade.split(':');
      const id = Number(idPart);
      if (Number.isInteger(id) && id > 0 && (GALLERY_GRADES as readonly string[]).includes(gradePart ?? '')) {
        void switchFutggSetGrade(id, gradePart as GalleryGrade);
        return;
      }
    }
    if (deps.getSniper()?.isRunning()) return;
    const g = currentGallery();
    const nameOfSet = (id: number) => g.sets?.find((x) => x.id === id)?.name ?? futggSets?.find((x) => x.id === id)?.name ?? 'Set';
    const remove = Number(target.closest<HTMLButtonElement>('button[data-remove-set]')?.dataset.removeSet);
    if (Number.isInteger(remove) && remove > 0) commitGallery(removeFutggSet(g, remove), `${nameOfSet(remove)} removed`);
    const complete = Number(target.closest<HTMLButtonElement>('button[data-complete]')?.dataset.complete);
    if (Number.isInteger(complete) && complete > 0) {
      futggPicked.delete(complete);
      commitGallery(setCompleted(g, complete, true), `${nameOfSet(complete)} marked completed`);
    }
    const uncomplete = Number(target.closest<HTMLButtonElement>('button[data-uncomplete]')?.dataset.uncomplete);
    if (Number.isInteger(uncomplete) && uncomplete > 0) commitGallery(setCompleted(g, uncomplete, false), `${nameOfSet(uncomplete)} no longer marked completed`);
  });
  onTrusted($('gallery'), 'input', (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (t.id === 'g-list') galleryDraft = t.value;
  });
  onTrusted($('gallery'), 'change', (e) => {
    const t = e.target as HTMLInputElement;
    // The fut.gg picker: a Set ticked or unticked (added at its best grade).
    const setId = Number(t.dataset.futgg);
    if (Number.isInteger(setId) && setId > 0) {
      const picked = futggSets?.find((x) => x.id === setId);
      const best = picked ? bestFutggTier(picked) : null;
      // Add at the highest grade that can be finished by buying alone: when the
      // best grade needs an SBC/Objective card, drop to the best buyable grade
      // (and keep the best grade as the upgrade target, set at add time). If no
      // grade is fully buyable, keep the best grade (its SBC card is flagged).
      const grade = picked && best ? ((best.sbc ?? 0) > 0 ? (bestBuyableFutggTier(picked)?.grade ?? best.grade) : best.grade) : null;
      if (t.checked && grade) futggPicked.set(setId, grade);
      else futggPicked.delete(setId);
      const add = root.getElementById('g-add') as HTMLButtonElement | null;
      if (add) {
        add.innerHTML = `<b>${futggAddLabel()}</b>`;
        add.disabled = futggPicked.size === 0 || futggBusy !== null || (deps.getSniper()?.isRunning() ?? false);
      }
      return;
    }
    if (t.id !== 'g-budget' || deps.getSniper()?.isRunning()) return;
    const v = Number(t.value.replace(/[,\s]/g, ''));
    if (!Number.isInteger(v) || v < GALLERY_LIMITS.budget.min || v > GALLERY_LIMITS.budget.max) {
      t.setAttribute('aria-invalid', 'true');
      say(`Not saved: the budget is a whole number of coins, up to ${fmt(GALLERY_LIMITS.budget.max)}`);
      return;
    }
    commitGallery({ ...currentGallery(), budget: v });
  });
  onTrusted($('close'), 'click', () => api.close());
  // Esc closes the page from anywhere on EA's page, like the nav item does.
  // An open list inside the page takes the first Esc (the search's keydown
  // handler stops it there).
  onTrusted(doc, 'keydown', (e) => {
    if (e.key === 'Escape' && !page.hidden) api.close();
  });

  const api: BotPage = {
    open() {
      if (!page.hidden) return;
      settings = deps.getSettings();
      modeSettings = deps.getModeSettings?.() ?? modeSettings;
      pending = null;
      renderSettings();
      page.hidden = false;
      // Lets the account button step aside while the page is open.
      host.dataset.open = '';
      refreshLive();
      void deps.prepare().then(() => {
        if (!page.hidden) refreshLive();
      });
      loadCatalog();
      loadRecent();
      // EA's lists arrive in two steps (files, then the web app's own lists
      // once it has started); pick each one up while the page is open.
      catalogPoll = setInterval(loadCatalog, 3_000);
      // EA updates its top bar after every buy, sale and pack: follow it.
      // The transfer list figures ride on the same tick, for a list EA's
      // page loads while the bot is stopped (nothing else refreshes the
      // dash then). When nothing changed the check is one string compare.
      // The open bids' time left counts down on it too.
      livePoll = setInterval(() => {
        renderWallet();
        renderTransferList();
        renderBids();
      }, 1_000);
      // refreshLive() above already drew the ring and, if the bot is running,
      // started the per-frame loop — so idle panels run no animation frame.
      openListeners.forEach((cb) => cb(true));
    },
    close() {
      if (page.hidden) return;
      page.hidden = true;
      delete host.dataset.open;
      if (ringFrame != null) cancelAnimationFrame(ringFrame);
      if (catalogPoll) clearInterval(catalogPoll);
      catalogPoll = null;
      if (livePoll) clearInterval(livePoll);
      livePoll = null;
      ringFrame = null;
      openListeners.forEach((cb) => cb(false));
    },
    toggle() {
      if (page.hidden) api.open();
      else api.close();
    },
    isOpen: () => !page.hidden,
    refresh: queueRefresh,
    setBounds({ left, top, right, bottom }) {
      const px = (n: number) => `${Math.max(0, Math.round(n))}px`;
      page.style.setProperty('--left', px(left));
      page.style.setProperty('--top', px(top));
      page.style.setProperty('--right', px(right));
      page.style.setProperty('--bottom', px(bottom));
    },
    onOpenChange(cb) {
      openListeners.add(cb);
    },
  };

  return api;
}
