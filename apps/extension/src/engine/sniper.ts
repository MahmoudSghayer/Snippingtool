/*
 * sniper.ts — the Sniping Bot: an automatic search -> buy loop driven by the
 * user's saved filters and the pacing on the Sniping Bot page
 * (`ui/bot-page.ts`, `BotSettings` in @sl/shared).
 *
 * Each cycle searches the next filter, collects what came back, and buys
 * every listing at or under the price cap, cheapest first. Searches start a
 * random delay from the user's range apart (measured start to start, so
 * EA's answer time and buying come out of the delay); every N searches it
 * takes a break; every N minutes it rests.
 *
 * The user sets every limit (within `BOT_LIMITS`); the defaults are the
 * recommended ones, and the page shows a live risk level for whatever the
 * user picks (`botRiskLevel`). This engine enforces the user's own numbers,
 * after clamping them into `BOT_LIMITS` (`clampBotSettings`), so a value
 * that got into storage some other way can never take it further:
 *
 *   - max searches per hour and max buys per hour: sliding one-hour windows
 *     here, and their sum as the governor's actions per hour;
 *   - the session (minutes before a rest) and the rest;
 *   - max active hours per day: non-rest running time per local calendar
 *     day, kept across page reloads through `loadUsage` / `saveUsage`;
 *   - max coins per hour and the buy:search ratio, through the governor
 *     (the ratio on this file's own search and buy windows, so it rolls with
 *     the hour: `Governor`'s `ratioCounts`);
 *   - the cooldown after every buy.
 *
 * Max buys per hour, the coin flow and the buy:search ratio count buys that
 * bought: a buy EA turned down (someone else's landed first) gives its coins
 * and its place back (`Governor.releaseSpend`), or a night of lost races
 * would use them up and leave the bot searching for nothing. The governor's
 * actions per hour still counts every request EA saw: that is the ban-risk
 * backstop. While one of those hourly budgets holds buying back, the bot
 * says so on the page (`SniperState.notice`), reports it once (one risk
 * event, one blocked attempt per search at most), and stops searching until
 * the window frees (`searchPause`), rather than searching for listings it
 * could not buy.
 *
 * The hourly budgets — the governor's windows and this file's own search and
 * buy windows — are one set per user, not per start or per tab: the governor
 * lives as long as this object (Stop/Start keeps it), its state and the
 * windows are saved through `saveBudget` after every action, and every
 * start loads them again through `loadBudget` before acting, so a start in
 * this tab sees what another EA tab spent since (only one tab runs the bot
 * at a time: `exclusive`, the engine lease in content/engine-lease.ts). If
 * they cannot be loaded (the service worker did not answer), the bot does
 * not start, and nothing is saved over the stored windows.
 *
 * Settings above low risk (`botRiskLevel`, which rates every limit the user
 * can raise) need the user's one-time acknowledgment (`riskAcknowledgedAt`),
 * which the page asks for. The engine enforces it itself: without it the
 * bot will not start, and settings changed to above low while it runs stop
 * it.
 *
 * What the user cannot turn off: every search and every buy still goes
 * through `governor.allow()`, the server kill switch stops the loop, and so
 * does an adapter probe failure or market-shape change — acting on an EA
 * app that no longer looks the way `main/adapter.ts` expects is never safe.
 */
import {
  BOT_GOVERNOR_BOUNDS,
  MAX_COIN_PRICE,
  MIN_SALE_PRICE,
  MIN_START_PRICE,
  botGovernorSettings,
  botRiskLevel,
  clampBotSettings,
  eaErrorCategory,
  roundToPriceStep,
  stepPrice,
} from '@sl/shared';

import { ACT_ERROR, isAdapterRefusal } from '../lib/act-auth.js';

import { Governor } from './governor.js';
import { attemptErrorCode } from './types.js';

import type { GovernorDecision, GovernorState, RatioCounts, RiskBudgetEventInput } from './governor.js';
import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';
import type {
  AdapterEaError,
  BotBudgetState,
  BotDailyUsage,
  BotPace,
  BotSettings,
  FilterCriteria,
  RiskEventKind,
  SnipeOutcome,
  TrimmedAuction,
} from '@sl/shared';

/** EA keeps 5% of every sale. */
const EA_TAX = 0.05;
const MAX_LOG_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const TOP_SNIPES = 5;
/** Consecutive failed searches before the bot gives up. */
const MAX_SEARCH_FAILURES_IN_A_ROW = 5;
/** The longest one sleep lasts while a limit holds the bot back: it then
 * checks again, so a raised limit, a rest coming due or a freed window take
 * effect within this. The page counts down to the real end. */
const BLOCKED_RECHECK_MS = 60_000;
/** Most cards whose sell price one search looks up ahead (`prefetchPrices`). */
const MAX_PREFETCH_PER_SEARCH = 20;

/**
 * Why a buy missed, in the user's words: never EA's raw wording or the
 * timings (they stay in the attempt telemetry). EA's codes as traders
 * report them; the common one on a snipe is someone else's buy landing
 * first.
 */
export function missReason(error: string | undefined): string {
  if (!error) return 'EA did not say why';
  const status = /status (\d{3})/.exec(error)?.[1];
  if (status) {
    if (status === '403' || status === '461' || status === '478') return 'someone else got it first';
    if (status === '470') return 'not enough coins';
    if (status === '458') return 'EA wants a verification: solve it in the web app';
    if (status === '401') return 'your EA session ended: reload the web app';
    if (status === '429' || status === '512' || status === '521') return 'EA is limiting requests: slow the bot down';
    return `EA refused it (error ${status})`;
  }
  if (error === ACT_ERROR.priceMismatch) return 'the price changed';
  if (error === ACT_ERROR.listingUnknown || error === ACT_ERROR.listingEntityUnknown) return 'the listing was gone';
  if (error === ACT_ERROR.resourceMismatch) return 'a different card was listed';
  if (error === ACT_ERROR.unauthenticated) return 'Nova AI lost its link to the page: reload it';
  if (/timed out/i.test(error)) return 'EA did not answer in time';
  return 'EA did not accept the buy';
}

/**
 * How a missed buy is reported (`AttemptInput.outcome`): `too_slow` when
 * someone else's buy landed first (EA's 403 / 461 / 478) or the listing was
 * already gone, `error` when EA was limiting requests or failing (429, 5xx
 * such as 512 / 521), `failed` for anything else.
 */
export function missOutcome(error: string | undefined): Extract<SnipeOutcome, 'too_slow' | 'error' | 'failed'> {
  const status = error ? /status (\d{3})/.exec(error)?.[1] : undefined;
  if (status === '403' || status === '461' || status === '478' || error === ACT_ERROR.listingUnknown) return 'too_slow';
  if (status === '429' || status?.startsWith('5')) return 'error';
  return 'failed';
}

/** How many EA price steps under the cap a search's max buy-now price may
 * step to keep the search fresh (`searchMaxBuy`)... */
const FRESH_SEARCH_STEPS = 5;
/** ...and no further under it than this share of the cap, after the first
 * step. */
const FRESH_SEARCH_SHARE = 0.1;

/**
 * The max buy-now price for a target's `round`th search (0 first).
 *
 * EA answers a search it was just asked, word for word, from its cache
 * (traders sniping by hand and community autobuyers both work around
 * this): a bot sending the same search every few seconds kept getting the
 * same results back, and saw a new listing only after other buyers had
 * had it. So each search steps the max buy-now price one notch down EA's
 * price grid from the cap, up to five steps (and 10% of the cap) under it,
 * then starts over: every search in a cycle asks EA something it was not
 * just asked. The cheapest listings, the ones a snipe is for, are in every
 * search; only the dearest few steps under the cap are left out, by some
 * searches of each cycle. (Stepping the min price up instead, as earlier
 * builds did, hid the cheapest listings.) The max never goes under EA's
 * lowest buy-now price or to the filter's own min. With no cap, the
 * searches step down from EA's highest buy-now price, leaving nothing out.
 */
export function searchMaxBuy(round: number, minPrice: number | undefined, cap: number | null): number | undefined {
  if (cap == null) {
    const prices = [undefined, ...Array.from({ length: FRESH_SEARCH_STEPS }, (_, i) => stepPrice(MAX_COIN_PRICE, -i))];
    return prices[round % prices.length];
  }
  const floor = Math.max(MIN_SALE_PRICE, (minPrice ?? 0) + 1);
  const share = cap * (1 - FRESH_SEARCH_SHARE);
  const prices = [cap];
  let p = cap;
  while (prices.length <= FRESH_SEARCH_STEPS) {
    const next = stepPrice(p, -1);
    if (next >= p || next < floor || (next < share && prices.length > 1)) break;
    prices.push(next);
    p = next;
  }
  return prices[round % prices.length];
}
/** Shortest wait when the governor refuses a search, so a denied loop never spins. */
const MIN_BLOCKED_WAIT_MS = 5_000;
/** How long a card's sell-price estimate is reused (`Sniper.sellPrice`). */
const PRICE_TTL_MS = 120_000;
/** How long an estimate past PRICE_TTL_MS may still decide the
 * minimum-profit check while its refresh is out (`knownSellPrice`). */
const PRICE_STALE_MS = 10 * 60_000;
const MAX_CACHED_PRICES = 500;
const MAX_SKIPS_REMEMBERED = 500;

/** A listing's estimated sell price and profit after EA's tax (null: unknown). */
interface Estimate {
  sellPrice: number | null;
  profit: number | null;
}

/** One card's sell-price lookup (`Sniper.sellPrice`), and its answer once
 * it came: what the minimum-profit check reads, never waiting. */
interface PriceEntry {
  at: number;
  value: Promise<number | null>;
  known?: { at: number; price: number | null };
}

/**
 * The price auto-sell lists a card at, given its market price (null: none
 * known): the user's own sell price when they set one (even with auto-sell
 * off: it is the price they said they sell at), else the market price,
 * moved by auto-sell's steps when auto-sell lists the card. Auto-sell lists
 * at it, and a buy's "sells for", its profit and the minimum-profit check
 * all use it, so none of them is an estimate the user never chose.
 */
export function plannedSalePrice(a: BotSettings['autoSell'], market: number | null): number | null {
  if (a.mode === 'fixed') return Math.max(MIN_SALE_PRICE, roundToPriceStep(a.fixedPrice));
  if (market == null) return null;
  return a.enabled ? Math.max(MIN_SALE_PRICE, stepPrice(market, a.steps)) : market;
}

/** What a card sold at `sellPrice` leaves over `buyPrice`, after EA's tax. */
function profitAfterTax(sellPrice: number, buyPrice: number): number {
  return Math.floor(sellPrice * (1 - EA_TAX)) - buyPrice;
}

/** A time of day as the page's clocks show it, for "resumes about 02:14". */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function coins(n: number): string {
  return `${n.toLocaleString('en-US')} coins`;
}
const ONE_HOUR_MS = 3_600_000;
/** How often the day's active time is written back while running. */
const USAGE_SAVE_EVERY_MS = 30_000;

/** Local calendar day, YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The union of two saved copies of one window: each entry as many times
 * as the copy holding it more often has it. Two buys in the same
 * millisecond are two buys; a plain Set would count them as one. */
function mergeCounted<T>(a: readonly T[], b: readonly T[], key: (item: T) => string): T[] {
  const count = (items: readonly T[]) => {
    const m = new Map<string, { item: T; n: number }>();
    for (const item of items) {
      const k = key(item);
      const e = m.get(k);
      if (e) e.n++;
      else m.set(k, { item, n: 1 });
    }
    return m;
  };
  const merged = count(a);
  for (const [k, e] of count(b)) {
    const mine = merged.get(k);
    if (!mine || mine.n < e.n) merged.set(k, e);
  }
  return [...merged.values()].flatMap((e) => Array.from({ length: e.n }, () => e.item));
}

export interface SniperFilter {
  id: string;
  name: string;
  filter: FilterCriteria;
}

export type SniperPhase =
  | 'idle'
  | 'searching'
  | 'buying'
  | 'cooldown'
  | 'waiting'
  | 'break'
  | 'rest'
  | 'blocked'
  /** EA is rate limiting or erroring: waiting before the next search. */
  | 'backoff'
  | 'stopped';

export type SniperStopReason =
  | 'manual'
  | 'no_filters'
  | 'kill_switch'
  | 'probe_failure'
  | 'shape_mismatch'
  | 'purchase_limit'
  | 'coin_budget'
  | 'session_length'
  | 'daily_limit'
  | 'risk_unacknowledged'
  /** The server answered, and the plan has no Nova AI. */
  | 'not_entitled'
  /** The Nova Trade session ended (signed out, revoked, the password
   * changed): never a plan problem. */
  | 'signed_out'
  /** The Nova Trade account could not be confirmed for a while (the API
   * unreachable, the extension restarting). */
  | 'account_unreachable'
  | 'other_tab'
  | 'budget_unavailable'
  | 'search_failing'
  | 'ea_session_ended'
  | 'ea_verification'
  /** EA kept rate limiting the bot after its protective rests. */
  | 'ea_rate_limited';

export interface SniperLogEntry {
  id: number;
  at: number;
  /** `listed`: auto-sell put a bought card on the market (`price` is its
   * buy-now, `message` how that price was chosen). */
  kind: 'bought' | 'listed' | 'failed' | 'blocked' | 'info';
  resourceId?: number;
  assetId?: number;
  rating?: number;
  price?: number;
  /** Estimated resale price, when the ledger has one. */
  sellPrice?: number | null;
  /** Estimated profit after EA's tax, when a resale price is known. */
  profit?: number | null;
  /** A buy's reaction time: from the listing reaching the bot to the buy
   * going out, in ms (bought and missed buys). */
  reactionMs?: number;
  message: string;
}

export interface SniperMatch {
  tradeId: string;
  resourceId: number;
  /** The card's base player id: what EA's player list (and so the player
   * names) are keyed on. Equal to `resourceId` for most cards. */
  assetId: number;
  rating: number;
  buyNow: number;
  expiresAt: number | null;
}

export interface SniperSearchResult {
  id: number;
  at: number;
  filterName: string;
  matches: SniperMatch[];
  /** How many listings EA's answer held (matching or not), and the lowest
   * buy-now among them: what tells "nothing listed at your price" apart
   * from "listed, but not what the search is for". */
  listings?: number;
  cheapest?: number | null;
}

export interface SniperStats {
  startedAt: number | null;
  searches: number;
  purchases: number;
  failures: number;
  coinsSpent: number;
  /** Sum of estimated profit over purchases with a known resale price. */
  profit: number;
  topSnipes: SniperLogEntry[];
}

export interface SniperState {
  phase: SniperPhase;
  /** When the current wait/break/rest ends, for the countdown ring. */
  phaseEndsAt: number | null;
  stopReason: SniperStopReason | null;
  stopDetail: string | null;
  /** While an hourly budget holds buying back: which one, the numbers and
   * when it frees, in the user's words (`BuyBlock.message`); else null. */
  notice: string | null;
}

/** A budget holding buying back (`Sniper.noteBlock`). */
interface BuyBlock {
  /** Which limit: the attempt's `errorCode`, and what tells two blocks apart. */
  code: 'coin_flow' | 'buys_per_hour' | 'buy_search_ratio' | 'actions_per_hour';
  /** The risk event it reports, with the value that went past `threshold`. */
  kind: Extract<RiskEventKind, 'coin_flow' | 'actions_per_hour' | 'buy_search_ratio'>;
  value: number;
  threshold: number;
  /** When buying can go again; null for the buy:search ratio, which more
   * searching lowers. */
  resumeAt: number | null;
  /** The coin flow: the price that did not fit, which the pause waits for. */
  coins?: number;
  message: string;
}

/** A search on its way (`Sniper.startSearch`). */
/** The kinds of wait a pace report adds up (`BotPace`): the phase each
 * wait runs in, mapped to its bucket (a rest counts as a break). */
type PaceWait = 'waitingMs' | 'backoffMs' | 'blockedMs' | 'breakMs' | 'cooldownMs';
const PACE_WAITS: Partial<Record<SniperPhase, PaceWait>> = {
  waiting: 'waitingMs',
  backoff: 'backoffMs',
  blocked: 'blockedMs',
  break: 'breakMs',
  rest: 'breakMs',
  cooldown: 'cooldownMs',
};
/** `BotPace`'s bounds: a window over an hour or a count past them is cut. */
const PACE_MAX_MS = 3_600_000;
const PACE_MAX_COUNT = 100_000;

/** What the bot did since the last pace report (`Sniper.takePace`). */
interface PaceWindow {
  since: number;
  searches: number;
  withResults: number;
  failed: number;
  /** Round trip of each answered search. */
  searchMs: number[];
  waits: Record<PaceWait, number>;
}

function newPaceWindow(since: number): PaceWindow {
  return {
    since,
    searches: 0,
    withResults: 0,
    failed: 0,
    searchMs: [],
    waits: { waitingMs: 0, backoffMs: 0, blockedMs: 0, breakMs: 0, cooldownMs: 0 },
  };
}

/** The `q` quantile of `sorted` (nearest rank), or null when empty. */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const paceMs = (ms: number): number => Math.min(PACE_MAX_MS, Math.max(0, Math.round(ms)));

interface SearchRun {
  /** Settles once a listing the bot can buy has arrived, or the search is over. */
  ready: Promise<void>;
  /** The search's own answer, once EA's is back (`at`), and its matches then. */
  done: Promise<
    | { ok: true; at: number; matches: SniperMatch[]; listings: number; cheapest: number | null }
    | { ok: false; error: string; at: number }
  >;
  /** Its matches so far, cheapest first. */
  matches: () => SniperMatch[];
  /** When the search went out to EA (for the search time). */
  sentAt: number;
  /** When a listing reached the bot buyable (for the reaction time). */
  arrivedAt: (tradeId: string) => number | undefined;
  /** The cards its listings are. */
  resourceIds: () => number[];
}

/** Where the time before a buy went (`AttemptInput.searchMs`/`reactionMs`). */
type Timings = Pick<AttemptInput, 'searchMs' | 'reactionMs'>;

/** How a batch of matches ended (`Sniper.buyMatches`): `dropped` when it
 * left the rest (a pause after a buy made them stale, or a budget holds
 * buying back). */
type BatchEnd = 'done' | 'dropped' | 'stopped';

/** `SniperDeps.account`'s answer while the account cannot be confirmed. */
export interface SniperAccountIssue {
  reason: Extract<SniperStopReason, 'signed_out' | 'account_unreachable'>;
  /** The stop message; omitted = the reason's own. */
  detail?: string;
}

export interface SniperDeps {
  adapter: Pick<AdapterClient, 'search' | 'buy' | 'list' | 'onAuctions' | 'onBuyable' | 'onProbe' | 'onShape'> &
    Partial<Pick<AdapterClient, 'onEaError'>>;
  getFilters: () => SniperFilter[];
  /** What a card sells for on the market now, or null if unknown. Used
   * where the user set no sell price of their own. */
  estimateSellPrice: (resourceId: number) => Promise<number | null>;
  /** Today's active time, as saved by an earlier page (null = none). */
  loadUsage?: () => Promise<BotDailyUsage | null>;
  saveUsage?: (usage: BotDailyUsage) => void;
  /** The hourly budgets as saved by an earlier page or another tab (null =
   * none saved). Must reject when they could not be read (no answer from
   * the service worker): a null there would refill every budget. */
  loadBudget?: () => Promise<BotBudgetState | null>;
  saveBudget?: (budget: BotBudgetState) => void;
  /** Whether the user's plan still includes the bot (`automation.autobuyer`
   * in the current entitlement). Checked before every action; omitted =
   * always. */
  entitled?: () => boolean;
  /** Why the Nova Trade account cannot be confirmed right now (signed out,
   * or unreachable for a while), with an optional message; null while it
   * can. Checked before every action, ahead of `entitled`, so a session that
   * ended is never reported as a plan problem. Omitted = always confirmed. */
  account?: () => SniperAccountIssue | null;
  /** Whether this tab holds the engine lease (only one EA tab runs an
   * engine at a time). Checked before every action; omitted = always. */
  exclusive?: () => boolean;
  /** The server kill switch as the content script currently knows it. */
  killSwitch: () => { active: boolean; reason?: string };
  /** Auto-sell's market price for a card: FUTBIN's, else Nova's own market
   * data, else null. Omitted = auto-sell's market mode never lists. */
  marketPrice?: (
    resourceId: number,
    platform: BotSettings['autoSell']['platform'],
  ) => Promise<{ price: number; source: 'futbin' | 'nova' } | null>;
  onChange: () => void;
  onLog?: (entry: SniperLogEntry) => void;
  onSearchResult?: (result: SniperSearchResult) => void;
  onAttempt?: (input: AttemptInput) => void;
  onTrade?: (input: TradeInput) => void;
  /** One risk-budget event (telemetry `riskEvents`) when an hourly budget
   * starts holding buying back: which one, its value and its threshold. */
  onRiskEvent?: (event: RiskBudgetEventInput) => void;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Whether `sleep` keeps its pace in a background tab (`worker`) or runs
   * on the page's throttled timers (`page`); said in the log at Start. */
  timingMode?: () => 'worker' | 'page';
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/** The first wait after an EA rate limit or server error, and the longest
 * it doubles to (`Sniper.onEaError`). */
const EA_BACKOFF_FIRST_MS = 5_000;
const EA_BACKOFF_MAX_MS = 120_000;
/** After EA limits the bot (429 / 512 / 521), it searches this much slower
 * (`eaPaceFactor`) until this long after the wait ends: twice as slow, three
 * times after a protective rest in the last `EA_REST_WINDOW_MS`. A clean
 * answer no longer puts it straight back to full speed — that is how it kept
 * running into EA's limit (Oct 18: 512 / 521 / 429 over and over at ~960
 * searches an hour). */
const EA_SLOW_MS = 15 * 60_000;
/** This many limits within `EA_LIMIT_WINDOW_MS` and the bot rests (the
 * waits in `EA_REST_MS`, one per rest so far); the rest after those, within
 * `EA_REST_WINDOW_MS` of the first, stops it (`ea_rate_limited`): EA's next
 * step is usually a transfer market ban. */
const EA_LIMITS_BEFORE_REST = 3;
const EA_LIMIT_WINDOW_MS = 10 * 60_000;
const EA_REST_MS = [15 * 60_000, 30 * 60_000];
const EA_REST_WINDOW_MS = 2 * 60 * 60_000;

function emptyStats(): SniperStats {
  return {
    startedAt: null,
    searches: 0,
    purchases: 0,
    failures: 0,
    coinsSpent: 0,
    profit: 0,
    topSnipes: [],
  };
}

export class Sniper {
  /** What the bot runs on: the user's settings clamped into BOT_LIMITS. */
  private settings: BotSettings;
  /** Sliding one-hour windows of search and buy times. A buy is counted
   * when it goes out and taken back if EA says it did not buy. */
  private searchTimes: number[] = [];
  private buyTimes: number[] = [];
  /** Sell-price estimates by resourceId (`sellPrice`). */
  private prices = new Map<number, PriceEntry>();
  /** The budget holding buying back now, if any (`noteBlock`). */
  private buyBlock: BuyBlock | null = null;
  /** Searches since the page loaded, and the one a blocked attempt was last
   * reported for: one per search at most. */
  private searchSeq = 0;
  private blockedAttemptSeq = -1;
  /** Listings already logged as skipped (`logSkip`). */
  private skipped = new Set<string>();
  /** Today's active (non-rest) time, and when the current active stretch
   * began (null while resting or stopped). */
  private usage: BotDailyUsage = { day: '', activeMs: 0 };
  private activeSince: number | null = null;
  private usageSavedAt = 0;
  private governor: Governor | null = null;
  /** Whether this start has loaded the saved budgets yet. Until it has, the
   * budgets are never saved (they would overwrite the stored ones). */
  private budgetHydrated = false;
  private abort: AbortController | null = null;
  /** The page's counters: kept across Stop and Start, like the log beside
   * them, until the page's reset button clears both (a Start that zeroed
   * them left a buy in the log that no counter showed). */
  private stats: SniperStats = emptyStats();
  /** This start's own buys, for the limits that apply to one run: stop
   * after N purchases, and the session coin budget. */
  private runTotals = { purchases: 0, coinsSpent: 0 };
  /** Since the last pace report (`takePace`). */
  private pace: PaceWindow = newPaceWindow(0);
  private stateValue: SniperState = {
    phase: 'idle',
    phaseEndsAt: null,
    stopReason: null,
    stopDetail: null,
    notice: null,
  };
  private readonly log: SniperLogEntry[] = [];
  private readonly results: SniperSearchResult[] = [];
  private nextId = 1;
  private filterIndex = 0;
  /** Searches sent for each filter (by id) since the bot started, for
   * `searchMaxBuy`. */
  private readonly searchRounds = new Map<string, number>();

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly deps: SniperDeps,
    settings: BotSettings,
  ) {
    this.settings = clampBotSettings(settings);
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? abortableSleep;
    deps.adapter.onProbe((status) => {
      if (!status.ok && this.isRunning())
        this.stop('probe_failure', status.reason ?? 'EA app check failed');
    });
    deps.adapter.onShape((reason, endpoint) => {
      // The trade pile only feeds the transfer list counts and the sale
      // tracking: a change there never stops the bot.
      if (endpoint !== 'pile' && this.isRunning()) this.stop('shape_mismatch', reason);
    });
    // EA's own errors, which the adapter files by kind (main/adapter.ts):
    // never a shape change. A clean market answer means EA answers again.
    deps.adapter.onEaError?.((error) => this.onEaError(error));
    // A clean market answer means EA answers again; after a rate limit the
    // wait only starts over once the slow period has passed.
    deps.adapter.onAuctions(() => {
      if (this.now() >= this.eaSlowUntil) this.eaBackoff.stepMs = 0;
    });
  }

  // ---- EA errors ------------------------------------------------------------

  /** EA rate limiting or erroring: the next search waits until `until`.
   * The wait doubles with each such error, from 5 s up to 2 minutes, and
   * starts over after a clean market answer (after a rate limit, only once
   * `eaSlowUntil` has passed). `at`: when the last one came, which excuses
   * the failed search it caused (`eaExcused`). */
  private eaBackoff = { stepMs: 0, until: 0, at: -Infinity };
  /** EA's rate limits since the last protective rest, and the rests taken
   * (`onEaError`); the bot searches slower until `eaSlowUntil`. Kept across
   * Stop/Start: EA's limit does not reset because the bot was restarted. */
  private eaLimits: number[] = [];
  private eaRests: number[] = [];
  private eaSlowUntil = -Infinity;

  /** What the bot does about an EA error. An expired session or a captcha
   * stops it, saying what to do. An outage makes it wait, longer each time.
   * A rate limit does too, then slows the bot down for a while; repeated
   * ones make it rest, and if EA keeps limiting it, stop before EA bans the
   * account from the market. A refusal (a buy someone else got first) is
   * that buy's own business, and the trade pile — read only for the
   * transfer list counts and the sale tracking — never stops or slows it,
   * whatever EA answers there. */
  private onEaError(error: AdapterEaError): void {
    if (!this.isRunning() || error.endpoint === 'pile' || error.endpoint === 'other') return;
    if (error.category === 'session_ended') return this.stop('ea_session_ended');
    if (error.category === 'verification') return this.stop('ea_verification');
    if (error.category !== 'rate_limited' && error.category !== 'server_error') return;
    const now = this.now();
    if (error.category === 'rate_limited' && this.onRateLimit(error.status, now)) return;
    const stepMs = this.eaBackoff.stepMs > 0 ? Math.min(this.eaBackoff.stepMs * 2, EA_BACKOFF_MAX_MS) : EA_BACKOFF_FIRST_MS;
    this.eaBackoff = { stepMs, until: Math.max(this.eaBackoff.until, now + stepMs), at: now };
    const what = error.category === 'rate_limited' ? 'EA is limiting requests' : 'EA had a server error';
    this.addLog({ kind: 'blocked', message: `${what} (HTTP ${error.status}): waiting ${Math.round(stepMs / 1000)} s before the next search` });
    if (error.category === 'rate_limited') this.slowDown(this.eaBackoff.until);
    this.deps.onChange();
  }

  /** Counts a rate limit. True when it was one too many: the bot rested
   * (the backoff now runs to the rest's end) or stopped. */
  private onRateLimit(status: number | string, now: number): boolean {
    this.eaLimits = [...this.eaLimits.filter((t) => now - t < EA_LIMIT_WINDOW_MS), now];
    if (this.eaLimits.length < EA_LIMITS_BEFORE_REST) return false;
    this.eaRests = this.eaRests.filter((t) => now - t < EA_REST_WINDOW_MS);
    const restMs = EA_REST_MS[this.eaRests.length];
    if (restMs === undefined) {
      this.stop('ea_rate_limited');
      return true;
    }
    this.eaRests.push(now);
    this.eaLimits = [];
    this.eaBackoff = { stepMs: 0, until: Math.max(this.eaBackoff.until, now + restMs), at: now };
    this.addLog({
      kind: 'blocked',
      message: `EA limited searches ${EA_LIMITS_BEFORE_REST} times in ${EA_LIMIT_WINDOW_MS / 60_000} minutes (HTTP ${status}): resting ${restMs / 60_000} min to protect your account`,
    });
    this.slowDown(this.eaBackoff.until);
    this.deps.onChange();
    return true;
  }

  /** Searches slower until `EA_SLOW_MS` after `from` (the end of the wait). */
  private slowDown(from: number): void {
    const wasSlow = this.now() < this.eaSlowUntil;
    this.eaSlowUntil = Math.max(this.eaSlowUntil, from + EA_SLOW_MS);
    if (!wasSlow) {
      this.addLog({
        kind: 'info',
        message: `EA asked the bot to slow down: searching ${this.eaPaceFactor()}× slower for the next ${EA_SLOW_MS / 60_000} minutes`,
      });
    }
  }

  /** How many times the search delay the bot waits now: 1 normally, 2 for a
   * while after EA limited it, 3 when it also had to rest recently. */
  private eaPaceFactor(): number {
    const now = this.now();
    if (now >= this.eaSlowUntil) return 1;
    return this.eaRests.some((t) => now - t < EA_REST_WINDOW_MS) ? 3 : 2;
  }

  /** Waits out an EA backoff before the next search. True when it waited:
   * the loop then starts over, re-checking every limit. */
  private async waitOutEaBackoff(signal: AbortSignal): Promise<boolean> {
    const ms = this.eaBackoff.until - this.now();
    if (ms <= 0) return false;
    await this.wait('backoff', ms, signal);
    return true;
  }

  /** Whether a search that failed (`error`, started at `startedAt`) was EA
   * rate limiting or erroring: it backs off instead of counting toward
   * MAX_SEARCH_FAILURES_IN_A_ROW, so EA slowing the bot down never stops
   * it. Normally the adapter's `ea_error` came first; failing that, EA's
   * status in the error text starts the backoff here. */
  private eaExcused(error: string, startedAt: number): boolean {
    if (this.eaBackoff.at >= startedAt) return true;
    const status = Number(/status (\d{3})/.exec(error)?.[1]);
    if (!Number.isInteger(status)) return false;
    const category = eaErrorCategory(status);
    if (category !== 'rate_limited' && category !== 'server_error') return false;
    this.onEaError({ status, category, endpoint: 'market', seenAt: this.now() });
    return true;
  }

  // ---- public surface ---------------------------------------------------

  get state(): SniperState {
    return this.stateValue;
  }

  getStats(): SniperStats {
    return this.stats;
  }

  /** How the bot searched since the last call, for the telemetry report
   * (`BotPace`), and a new window from now. Null when it did nothing in
   * that time (stopped). A search that finds nothing is reported nowhere
   * else, so this is what shows the bot's real search pace. */
  takePace(): BotPace | null {
    const p = this.pace;
    const now = this.now();
    this.pace = newPaceWindow(now);
    const waited = Object.values(p.waits).reduce((a, b) => a + b, 0);
    if (p.searches === 0 && waited === 0) return null;
    const sorted = [...p.searchMs].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p90 = quantile(sorted, 0.9);
    const count = (n: number) => Math.min(PACE_MAX_COUNT, n);
    return {
      windowMs: Math.max(1, paceMs(now - p.since)),
      searches: count(p.searches),
      withResults: count(p.withResults),
      failed: count(p.failed),
      searchMsP50: p50 == null ? null : paceMs(p50),
      searchMsP90: p90 == null ? null : paceMs(p90),
      waitingMs: paceMs(p.waits.waitingMs),
      backoffMs: paceMs(p.waits.backoffMs),
      blockedMs: paceMs(p.waits.blockedMs),
      breakMs: paceMs(p.waits.breakMs),
      cooldownMs: paceMs(p.waits.cooldownMs),
    };
  }

  getLog(): readonly SniperLogEntry[] {
    return this.log;
  }

  getSearchResults(): readonly SniperSearchResult[] {
    return this.results;
  }

  getGovernor(): Governor | null {
    return this.governor;
  }

  isRunning(): boolean {
    return this.abort != null;
  }

  /** The settings the bot actually runs on (clamped into BOT_LIMITS). */
  getEffectiveSettings(): BotSettings {
    return this.settings;
  }

  /** Active time counted today, in ms (for the page and tests). */
  getActiveMsToday(): number {
    return this.usage.activeMs + (this.activeSince == null ? 0 : this.now() - this.activeSince);
  }

  /** Takes effect from the next wait/break/rest; the limits apply to the
   * running governor straight away. */
  setSettings(settings: BotSettings): void {
    this.settings = clampBotSettings(settings);
    this.governor?.setSettings(botGovernorSettings(this.settings), BOT_GOVERNOR_BOUNDS);
    // Settings raised above low while running, with no acknowledgment: the
    // same rule as start(), enforced here, not only on the page.
    if (this.isRunning() && this.riskUnacknowledged()) this.stop('risk_unacknowledged');
  }

  private riskUnacknowledged(): boolean {
    return botRiskLevel(this.settings).level !== 'low' && !this.settings.riskAcknowledgedAt;
  }

  start(): void {
    if (this.isRunning()) return;
    const filters = this.deps.getFilters();
    if (filters.length === 0) {
      this.setState({
        phase: 'stopped',
        phaseEndsAt: null,
        stopReason: 'no_filters',
        stopDetail: 'Add a filter to snipe first.',
      });
      return;
    }
    if (this.riskUnacknowledged()) {
      this.setState({
        phase: 'stopped',
        phaseEndsAt: null,
        stopReason: 'risk_unacknowledged',
        stopDetail: STOP_MESSAGES.risk_unacknowledged,
      });
      return;
    }
    const accountIssue = this.deps.account?.() ?? null;
    if (accountIssue) {
      this.setState({
        phase: 'stopped',
        phaseEndsAt: null,
        stopReason: accountIssue.reason,
        stopDetail: accountIssue.detail ?? STOP_MESSAGES[accountIssue.reason],
      });
      return;
    }
    if (this.deps.entitled && !this.deps.entitled()) {
      this.setState({
        phase: 'stopped',
        phaseEndsAt: null,
        stopReason: 'not_entitled',
        stopDetail: STOP_MESSAGES.not_entitled,
      });
      return;
    }
    if (this.deps.exclusive && !this.deps.exclusive()) {
      this.setState({
        phase: 'stopped',
        phaseEndsAt: null,
        stopReason: 'other_tab',
        stopDetail: STOP_MESSAGES.other_tab,
      });
      return;
    }
    this.abort = new AbortController();
    this.budgetHydrated = false;
    // One governor for the life of this object: Stop/Start keeps its
    // windows (and the search/buy windows below) rather than refilling them.
    if (this.governor) {
      this.governor.setSettings(botGovernorSettings(this.settings), BOT_GOVERNOR_BOUNDS);
    } else {
      this.governor = this.newGovernor();
    }
    this.buyBlock = null;
    this.stats.startedAt = this.now();
    this.runTotals = { purchases: 0, coinsSpent: 0 };
    this.pace = newPaceWindow(this.now());
    this.filterIndex = 0;
    this.searchRounds.clear();
    // The sell prices the minimum-profit check reads, looked up now so the
    // first matches find them: a buy never waits for one.
    this.prefetchPrices(filters.map((f) => f.filter.resourceId).filter((id): id is number => id != null));
    this.addLog({ kind: 'info', message: 'Bot started' });
    const timing = this.deps.timingMode?.();
    if (timing === 'worker') this.addLog({ kind: 'info', message: 'Background searching is on: the bot keeps its pace in another tab' });
    else if (timing === 'page')
      this.addLog({
        kind: 'info',
        message: "Background searching is limited: this page blocked the bot's background timer, so searching slows down while the tab is hidden",
      });
    void this.run(this.abort.signal).catch((err) => this.stop('search_failing', String(err)));
  }

  stop(reason: SniperStopReason = 'manual', detail?: string): void {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = null;
    this.buyBlock = null;
    this.pauseActive(true);
    this.persistBudget();
    const message = detail ?? STOP_MESSAGES[reason];
    this.addLog({ kind: 'info', message: `Bot stopped: ${message}` });
    this.setState({ phase: 'stopped', phaseEndsAt: null, stopReason: reason, stopDetail: message });
  }

  /** Clears the counters, log and results (the page's reset button). */
  reset(): void {
    if (this.isRunning()) return;
    this.stats = emptyStats();
    this.runTotals = { purchases: 0, coinsSpent: 0 };
    this.log.length = 0;
    this.results.length = 0;
    this.setState({ phase: 'idle', phaseEndsAt: null, stopReason: null, stopDetail: null });
  }

  // ---- the loop -----------------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    const s = () => this.settings;
    let searchesSinceBreak = 0;
    let nextBreakAfter = this.pickInt(s().breaks.searches);
    let restAt = this.now() + this.pickInt(s().rest.afterMinutes) * 60_000;
    let failuresInRow = 0;

    const saved = await this.deps.loadUsage?.().catch(() => null);
    if (signal.aborted) return;
    this.usage =
      saved && saved.day === localDay(this.now()) ? { ...saved } : { day: localDay(this.now()), activeMs: 0 };
    this.activeSince = this.now();
    // Every start: another EA tab may have spent some of the budgets since
    // this one last ran. Marked loaded only on a real answer (finding A: a
    // failed load used to count as "nothing saved", and the next save then
    // wrote fresh, empty windows over the stored ones).
    if (this.deps.loadBudget) {
      let budget: BotBudgetState | null;
      try {
        budget = await this.deps.loadBudget();
      } catch {
        if (signal.aborted) return;
        return this.stop('budget_unavailable');
      }
      if (signal.aborted) return;
      if (budget) this.hydrateBudget(budget);
    }
    this.budgetHydrated = true;

    while (!signal.aborted) {
      if (this.dailyLimitReached()) return this.stop('daily_limit');
      if (s().rest.enabled && this.now() >= restAt) {
        const restMs = this.pickInt(s().rest.minutes) * 60_000;
        this.pauseActive(true);
        await this.wait('rest', restMs, signal);
        if (signal.aborted) return;
        this.activeSince = this.now();
        restAt = this.now() + this.pickInt(s().rest.afterMinutes) * 60_000;
        continue;
      }
      if (s().breaks.enabled && searchesSinceBreak >= nextBreakAfter) {
        await this.wait('break', this.pickInt(s().breaks.seconds) * 1000, signal);
        searchesSinceBreak = 0;
        nextBreakAfter = this.pickInt(s().breaks.searches);
        continue;
      }

      const filters = this.deps.getFilters();
      if (filters.length === 0) return this.stop('no_filters');

      // Picked once a search may go: a wait at the gate does not skip a filter.
      const gate = await this.searchGate(signal);
      if (gate === 'stopped') return;
      if (gate === 'wait') continue;
      const target = filters[this.filterIndex++ % filters.length]!;

      // The search delay runs from this search's start to the next one's,
      // so the time EA takes to answer, and any buying, come out of it
      // rather than being added on top: the same pace, less dead time.
      const startedAt = this.now();
      const search = this.startSearch(target);
      await search.ready;
      if (signal.aborted) return;
      this.stats.searches++;
      this.searchSeq++;
      searchesSinceBreak++;
      // What the bot can buy is bought the moment it arrives, before the
      // search's own answer is in: the adapter checks every buy against the
      // listing it saw itself (price, card and expiry, main/adapter.ts
      // `priceCheck`), whatever told the bot about it. Anything that
      // arrives after (a listing the search's answer makes buyable) follows.
      const tried = new Set<string>();
      const first = search.matches();
      const end = first.length > 0 ? await this.buyMatches(first, search, tried, signal) : 'done';
      if (end === 'stopped') return;
      const found = await search.done;
      if (signal.aborted) return;
      this.pace.searches++;
      if (!found.ok) this.pace.failed++;
      else {
        this.pace.searchMs.push(found.at - startedAt);
        if (found.listings > 0) this.pace.withResults++;
      }
      if (!found.ok) {
        if (!this.eaExcused(found.error, startedAt)) failuresInRow++;
        this.addLog({ kind: 'failed', message: `Search "${target.name}" failed: ${found.error}` });
        if (failuresInRow >= MAX_SEARCH_FAILURES_IN_A_ROW) return this.stop('search_failing');
      } else {
        failuresInRow = 0;
        this.addSearchResult(target.name, found.matches, found.listings, found.cheapest, found.at);
        this.prefetchPrices(search.resourceIds());
        const rest = end === 'done' ? found.matches.filter((m) => !tried.has(m.tradeId)) : [];
        if (rest.length > 0 && (await this.buyMatches(rest, search, tried, signal)) === 'stopped') return;
      }
      this.deps.onChange();

      const delayMs = this.pickSeconds(s().searchDelay) * 1000 * this.eaPaceFactor();
      await this.wait('waiting', Math.max(0, delayMs - (this.now() - startedAt)), signal);
    }
  }

  /** Whether a search may go out now: the kill switch, plan and engine
   * lease, an hourly budget holding buying back, the user's
   * searches-per-hour window and the governor. `wait`: it waited out a
   * limit, so the loop starts over. */
  private async searchGate(signal: AbortSignal): Promise<'go' | 'wait' | 'stopped'> {
    if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return 'stopped';
    if (await this.waitOutEaBackoff(signal)) return signal.aborted ? 'stopped' : 'wait';
    // A search could buy nothing while the buy window or the coin flow is
    // full: sleep until it frees instead (one night, the bot searched for
    // four hours that way and bought nothing).
    const pause = this.searchPause();
    if (pause) {
      this.noteBlock(pause, null);
      await this.waitBlocked(pause.resumeAt!, signal);
      return signal.aborted ? 'stopped' : 'wait';
    }
    const searchWait = this.windowWait(this.searchTimes, this.settings.safety.maxSearchesPerHour);
    if (searchWait > 0) {
      this.addLog({
        kind: 'blocked',
        message: `Search paused: ${this.searchTimes.length} searches in the last hour (your limit)`,
      });
      await this.wait('blocked', Math.max(searchWait, MIN_BLOCKED_WAIT_MS), signal);
      return signal.aborted ? 'stopped' : 'wait';
    }
    const decision = this.governor!.allow({ kind: 'search' });
    if (decision.allowed) {
      // The windows have room again (the buy:search ratio: once a buy would pass it).
      if (this.buyBlock && (this.buyBlock.code !== 'buy_search_ratio' || this.governor!.ratioAllowsBuy())) this.endBlock();
      return 'go';
    }
    this.persistBudget(); // a hard stop's cooldown is part of the budget
    if (decision.reason === 'kill_switch') {
      this.stop('kill_switch', decision.detail);
      return 'stopped';
    }
    if (decision.detail?.startsWith('session_length')) {
      this.stop('session_length');
      return 'stopped';
    }
    if (decision.reason === 'hard_stop') {
      // Searches and buys together past the governor's actions per hour:
      // sleep until the window has room, not one cooldown at a time.
      const block = this.actionsBlock(decision);
      this.noteBlock(block, null);
      await this.waitBlocked(block.resumeAt!, signal);
      return signal.aborted ? 'stopped' : 'wait';
    }
    this.addLog({ kind: 'blocked', message: `Search paused by safety limits (${decision.detail ?? decision.reason})` });
    await this.wait('blocked', Math.max(this.governor!.snapshot().cooldownRemainingMs, MIN_BLOCKED_WAIT_MS), signal);
    return signal.aborted ? 'stopped' : 'wait';
  }

  /** What holds buying back now, when a search would be wasted on it: the
   * buys-per-hour window full, or a coin-flow block whose spend has not
   * aged out yet (the buy:search ratio is not one: searching is what lowers
   * it). Null once buying can go again. */
  private searchPause(): BuyBlock | null {
    const buyWait = this.windowWait(this.buyTimes, this.settings.safety.maxBuysPerHour);
    if (buyWait > 0) return this.buysPerHourBlock(buyWait);
    const b = this.buyBlock;
    if (b?.code === 'coin_flow' && b.coins != null) {
      const at = this.governor!.coinFlowFreesAt(b.coins);
      if (at != null && at > this.now()) return this.coinFlowBlock(b.coins, at);
    }
    return null;
  }

  /** Sleeps toward `resumeAt`, at most BLOCKED_RECHECK_MS at a time, so the
   * loop checks again in between; the page counts down to `resumeAt`. The
   * bot is not searching meanwhile, so, like a rest, it does not count
   * toward the active hours a day. */
  private async waitBlocked(resumeAt: number, signal: AbortSignal): Promise<void> {
    const ms = Math.max(Math.min(resumeAt - this.now(), BLOCKED_RECHECK_MS), MIN_BLOCKED_WAIT_MS);
    this.pauseActive(false);
    await this.wait('blocked', ms, signal, Math.max(resumeAt, this.now() + ms));
    if (!signal.aborted) this.activeSince = this.now();
  }

  /** A budget holds buying back. The first time (or when another budget
   * takes over) that is one log line and one risk event; while it lasts the
   * page shows its message, and a search whose match it refused reports one
   * blocked attempt, never one per listing. */
  private noteBlock(block: BuyBlock, m: SniperMatch | null): void {
    const starts = this.buyBlock?.code !== block.code;
    this.buyBlock = block;
    if (starts) {
      this.addLog({ kind: 'blocked', message: block.message });
      this.deps.onRiskEvent?.({ kind: block.kind, value: block.value, threshold: block.threshold });
    }
    if (m && this.blockedAttemptSeq !== this.searchSeq) {
      this.blockedAttemptSeq = this.searchSeq;
      this.deps.onAttempt?.({ ...this.attemptBase(m), outcome: 'blocked', latencyMs: null, errorCode: block.code });
    }
    this.stateValue = { ...this.stateValue, notice: block.message };
    this.deps.onChange();
  }

  /** The budget that held buying back has room again. */
  private endBlock(): void {
    if (!this.buyBlock) return;
    this.buyBlock = null;
    this.addLog({ kind: 'info', message: 'Buying resumed: your limits have room again' });
    this.stateValue = { ...this.stateValue, notice: null };
    this.deps.onChange();
  }

  private buysPerHourBlock(waitMs: number): BuyBlock {
    const limit = this.settings.safety.maxBuysPerHour;
    const n = this.buyTimes.length;
    const resumeAt = this.now() + waitMs;
    return {
      code: 'buys_per_hour',
      kind: 'actions_per_hour',
      value: n + 1,
      threshold: limit,
      resumeAt,
      message: `Buying paused: buy limit (${n} of ${plural(limit, 'buy')} in the last hour) — resumes about ${clockTime(resumeAt)}`,
    };
  }

  private coinFlowBlock(price: number, resumeAt: number): BuyBlock {
    const { coinFlowLastHour: flow, coinFlowLimit: limit } = this.governor!.snapshot();
    return {
      code: 'coin_flow',
      kind: 'coin_flow',
      value: flow + price,
      threshold: limit,
      resumeAt,
      coins: price,
      message: `Buying paused: coin-flow limit (${flow.toLocaleString('en-US')} of ${coins(limit)} in the last hour) — resumes about ${clockTime(resumeAt)}`,
    };
  }

  private ratioBlock(decision: GovernorDecision): BuyBlock {
    const limit = this.settings.safety.buyToSearchRatio;
    const { searches, buys } = this.ratioCounts();
    const event = decision.events.find((e) => e.kind === 'buy_search_ratio');
    // Searches the hour needs before one more buy fits: (buys + 1) / searches <= limit.
    const more = Math.max(1, Math.ceil((buys + 1) / limit - 1e-9) - searches);
    return {
      code: 'buy_search_ratio',
      kind: 'buy_search_ratio',
      value: event?.value ?? (buys + 1) / Math.max(searches, 1),
      threshold: limit,
      resumeAt: null,
      message: `Buying paused: buys-per-search limit (${plural(buys, 'buy')} for ${plural(searches, 'search', 'searches')} in the last hour, your limit is ${limit} a search) — resumes after about ${plural(more, 'more search', 'more searches')}`,
    };
  }

  private actionsBlock(decision: GovernorDecision): BuyBlock {
    const { actionsLastHour: n, actionsPerHourLimit: limit } = this.governor!.snapshot();
    const resumeAt = this.governor!.actionsFreeAt();
    const event = decision.events.find((e) => e.kind === 'actions_per_hour');
    return {
      code: 'actions_per_hour',
      kind: 'actions_per_hour',
      value: event?.value ?? n + 1,
      threshold: limit,
      resumeAt,
      message: `Paused: safety limit of ${plural(limit, 'search and buy', 'searches and buys')} an hour (${n} in the last hour) — resumes about ${clockTime(resumeAt)}`,
    };
  }

  /** The budget a governor refusal of a buy of `m` is, or null when the
   * listing alone costs more than the whole hourly coin flow. */
  private governorBlock(decision: GovernorDecision, m: SniperMatch): BuyBlock | null {
    if (decision.reason === 'coin_flow') {
      const at = this.governor!.coinFlowFreesAt(m.buyNow);
      return at == null ? null : this.coinFlowBlock(m.buyNow, at);
    }
    if (decision.reason === 'buy_search_ratio') return this.ratioBlock(decision);
    return this.actionsBlock(decision);
  }

  /** One search through the adapter: what it has found at or under the
   * price cap so far, and its answer once EA's is back. `ready` settles at
   * the first listing the bot can buy, without waiting for that answer. */
  private startSearch(target: SniperFilter): SearchRun {
    this.setState({ phase: 'searching', phaseEndsAt: null, stopReason: null, stopDetail: null });
    const cap = this.priceCap(target.filter);
    const collected = new Map<string, TrimmedAuction>();
    const arrived = new Map<string, number>();
    let wake!: () => void;
    const ready = new Promise<void>((resolve) => (wake = resolve));
    const matches = (): SniperMatch[] =>
      [...collected.values()]
        .filter((a) => this.matches(a, target.filter, cap))
        .sort((a, b) => a.buyNow - b.buyNow)
        .map((a) => ({
          tradeId: a.tradeId,
          resourceId: a.resourceId,
          assetId: a.assetId,
          rating: a.rating,
          buyNow: a.buyNow,
          expiresAt: a.expiresAt,
        }));
    const take = (a: TrimmedAuction): void => {
      collected.set(a.tradeId, a);
      if (a.buyable !== false && !arrived.has(a.tradeId)) arrived.set(a.tradeId, this.now());
    };
    const offer = (): void => {
      if (matches().length > 0) wake();
    };
    const off = this.deps.adapter.onAuctions((raw) => {
      for (const a of raw as TrimmedAuction[]) take(a);
      offer();
    });
    // When the search's network response reaches the adapter before its
    // own search call returns, the listings arrive marked unbuyable (no
    // item entity yet), and the call's result only upgrades them
    // (main/adapter.ts, isSecondSighting): without this, that search
    // would buy nothing.
    const offBuyable = this.deps.adapter.onBuyable((tradeIds) => {
      for (const id of tradeIds) {
        const a = collected.get(id);
        if (a) take({ ...a, buyable: true });
      }
      offer();
    });
    // Refresh the estimate for the card this filter targets while EA
    // searches, so the minimum-profit check finds it.
    if (this.needsMarketEstimate() && target.filter.resourceId != null) void this.sellPrice(target.filter.resourceId);
    const round = this.searchRounds.get(target.id) ?? 0;
    this.searchRounds.set(target.id, round + 1);
    const criteria: FilterCriteria = { ...target.filter };
    const maxBuy = searchMaxBuy(round, target.filter.minPrice, cap);
    if (maxBuy != null) criteria.maxPrice = maxBuy;
    const sentAt = this.now();
    this.searchTimes.push(sentAt);
    const searching = this.deps.adapter.search(criteria);
    // Saved once the search is on its way, not before it.
    this.persistBudget();
    const done = searching
      .finally(() => {
        off();
        offBuyable();
        wake();
      })
      .then((outcome) => {
        const at = this.now();
        if (!outcome.ok) return { ok: false as const, error: outcome.error ?? 'unknown error', at };
        const prices = [...collected.values()].map((a) => a.buyNow).filter((p) => p > 0);
        return {
          ok: true as const,
          at,
          matches: matches(),
          listings: collected.size,
          cheapest: prices.length ? Math.min(...prices) : null,
        };
      });
    // The loop stops waiting for it when the bot stops mid-buy: a failure
    // then must not go unheard as an unhandled rejection.
    done.catch(() => undefined);
    return {
      ready,
      done,
      matches,
      sentAt,
      arrivedAt: (tradeId) => arrived.get(tradeId),
      resourceIds: () => [...new Set([...collected.values()].map((a) => a.resourceId))],
    };
  }

  /** Buys `matches`, cheapest first (each one added to `tried`). */
  private async buyMatches(
    matches: SniperMatch[],
    search: SearchRun,
    tried: Set<string>,
    signal: AbortSignal,
  ): Promise<BatchEnd> {
    const t = this.settings.thresholds;
    this.setState({ phase: 'buying', phaseEndsAt: null, stopReason: null, stopDetail: null });
    for (const m of matches) {
      if (signal.aborted) return 'stopped';
      tried.add(m.tradeId);

      if (t.sessionCoinBudget > 0 && this.runTotals.coinsSpent + m.buyNow > t.sessionCoinBudget) {
        if (this.runTotals.coinsSpent >= t.sessionCoinBudget) {
          this.stop('coin_budget');
          return 'stopped';
        }
        this.logSkip(m, 'it would go over your session coin budget');
        continue; // a cheaper listing may still fit
      }

      // Only the minimum-profit check needs the sale price before buying,
      // and it never waits for one: the user's own sell price is known at
      // once, a market price once its lookup (started at Start and after
      // every search) has answered. Without one the buy goes first (a
      // listing this cheap is gone in moments) and the estimate is looked
      // up afterwards, for the log.
      let estimate: Estimate | null = null;
      if (t.minProfit > 0) {
        estimate = this.knownEstimate(m);
        // Unknown profit is allowed: the user capped the price, and the
        // ledger may simply not have seen this card sell yet.
        if (estimate?.profit != null && estimate.profit < t.minProfit) {
          this.logSkip(
            m,
            `estimated profit ${coins(estimate.profit)} is under your minimum profit (${coins(t.minProfit)})`,
          );
          continue;
        }
      }

      if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return 'stopped';
      // EA is limiting requests or erroring (`onEaError`): more buys now only
      // add to it. The next search waits the backoff out.
      if (this.eaBackoff.until > this.now()) return 'dropped';
      const buyWait = this.windowWait(this.buyTimes, this.settings.safety.maxBuysPerHour);
      if (buyWait > 0) {
        this.noteBlock(this.buysPerHourBlock(buyWait), m);
        return 'dropped';
      }
      const decision = this.governor!.allow({ kind: 'buy', coins: m.buyNow });
      if (!decision.allowed) {
        this.persistBudget(); // a hard stop's cooldown is part of the budget
        if (decision.reason === 'kill_switch') {
          this.stop('kill_switch', decision.detail);
          return 'stopped';
        }
        const block = this.governorBlock(decision, m);
        if (block) this.noteBlock(block, m);
        else this.logSkip(m, `it costs more than your coins per hour (${coins(this.settings.safety.maxCoinFlowPerHour)})`);
        // Every listing after this one costs at least as much.
        return 'dropped';
      }
      this.endBlock();

      // Counted in the buy window now, and taken back below if EA says it
      // did not buy.
      const at = this.now();
      this.buyTimes.push(at);
      // Where the time before this buy went, for the log and the telemetry:
      // EA answering the search, then the bot reacting.
      const arrivedAt = search.arrivedAt(m.tradeId);
      const reactionMs = arrivedAt == null ? undefined : at - arrivedAt;
      const timings: Timings = { searchMs: arrivedAt == null ? undefined : arrivedAt - search.sentAt, reactionMs };
      // The resourceId binds the buy to the card this filter targets: the
      // adapter refuses it unless the listing it saw for this tradeId is
      // that card (a forged `auctions` message can claim any tradeId).
      const buying = this.deps.adapter.buy(m.tradeId, m.buyNow, {
        resourceId: m.resourceId,
        assetId: m.assetId,
      });
      // Saved once the buy is on its way, not before it.
      this.persistBudget();
      const result = await buying;
      if (result.error === ACT_ERROR.timeoutUnknown) {
        // It reached EA, which had not answered in time: it may have bought.
        // Never retried (a retry could buy twice), still charged to the
        // governor and the hourly limit, and settled by EA's late answer if
        // one comes (content/adapter-client.ts), as the autobuyer does.
        this.addLog({
          kind: 'failed',
          resourceId: m.resourceId,
          assetId: m.assetId,
          rating: m.rating,
          price: m.buyNow,
          reactionMs,
          message: 'no answer from EA in time — it may still have bought; waiting for its answer',
        });
        this.deps.onAttempt?.({
          ...this.attemptBase(m),
          ...timings,
          outcome: 'attempted',
          latencyMs: result.latencyMs,
          errorCode: ACT_ERROR.timeoutUnknown,
        });
        void result.late?.then((late) => {
          if (!late.ok) {
            // EA's signed late answer says it did not buy: its spend comes
            // back, as for any buy EA turned down.
            if (late.signed) {
              this.releaseBuy(decision, at);
              this.persistBudget();
            }
            return;
          }
          this.recordBought(m, late.latencyMs, estimate, timings);
          // Shown now, not at the next search (the bot may have stopped).
          this.deps.onChange();
          this.autoSellInBackground(m);
        });
        if (signal.aborted) return 'stopped';
        this.deps.onChange();
        continue;
      }
      if (signal.aborted && !result.ok) return 'stopped';
      if (result.ok) {
        // Nothing after a buy holds the bot up: the sell price fills in
        // when its lookup answers, and the listing (a FUTBIN lookup and
        // EA's listing call) runs on its own, while the bot goes straight
        // on to the next listing and search. Only the user's own pause
        // after a buy, when they set one, waits.
        this.recordBought(m, result.latencyMs, estimate, timings);
        this.autoSellInBackground(m);
        if (t.stopAfterPurchases > 0 && this.runTotals.purchases >= t.stopAfterPurchases) {
          this.stop('purchase_limit');
          return 'stopped';
        }
        const cooldownMs = this.settings.safety.cooldownSeconds * 1000;
        if (cooldownMs > 0) {
          await this.wait('cooldown', cooldownMs, signal);
          if (signal.aborted) return 'stopped';
          // What this search found is that pause old: other buyers have
          // had it. The next search looks again.
          return 'dropped';
        }
      } else {
        // A signed answer settles what this buy took. The adapter's own
        // refusals (lib/act-auth.ts) never reached EA: the governor and the
        // hourly limit get back all of it. A buy EA turned down (someone
        // else's landed first) gives back its coins and its place in the
        // hourly buy limit and the buy:search ratio, and stays an action EA
        // saw. An unsigned outcome may hide a buy that happened: it stays
        // charged. Saved with the next action (until then the stored
        // budget only counts more).
        if (result.signed && isAdapterRefusal(result.error)) {
          this.governor!.refund(decision);
          this.dropBuyTime(at);
        } else if (result.signed) {
          this.releaseBuy(decision, at);
        }
        this.stats.failures++;
        this.addLog({
          kind: 'failed',
          resourceId: m.resourceId,
          assetId: m.assetId,
          rating: m.rating,
          price: m.buyNow,
          reactionMs,
          message: missReason(result.error),
        });
        this.deps.onAttempt?.({
          ...this.attemptBase(m),
          ...timings,
          outcome: missOutcome(result.error),
          latencyMs: result.latencyMs,
          errorCode: attemptErrorCode(result.error),
        });
      }
      this.deps.onChange();
    }
    return 'done';
  }

  /** A buy that reached EA and bought nothing: its coins and its place in
   * the buy window come back (`Governor.releaseSpend`). */
  private releaseBuy(decision: GovernorDecision, at: number): void {
    this.governor?.releaseSpend(decision);
    this.dropBuyTime(at);
  }

  private dropBuyTime(at: number): void {
    const i = this.buyTimes.lastIndexOf(at);
    if (i !== -1) this.buyTimes.splice(i, 1);
  }

  // ---- helpers --------------------------------------------------------------

  /** The sell-price estimate for a card, shared by every listing of it for
   * PRICE_TTL_MS: a filter keeps finding the same card, and each lookup is a
   * round trip to the service worker. Its answer, once in, is kept beside it
   * for the minimum-profit check (`knownSellPrice`), the last one until a
   * refresh has answered. */
  private sellPrice(resourceId: number): Promise<number | null> {
    const now = this.now();
    const hit = this.prices.get(resourceId);
    if (hit && now - hit.at < PRICE_TTL_MS) return hit.value;
    const entry: PriceEntry = { at: now, value: this.deps.estimateSellPrice(resourceId).catch(() => null), known: hit?.known };
    void entry.value.then((price) => (entry.known = { at: this.now(), price }));
    this.prices.set(resourceId, entry);
    if (this.prices.size > MAX_CACHED_PRICES) this.prices.delete(this.prices.keys().next().value!);
    return entry.value;
  }

  /** A card's market price as far as a lookup has answered, without
   * waiting: undefined while none has (or the last is too old to go on). */
  private knownSellPrice(resourceId: number): number | null | undefined {
    const known = this.prices.get(resourceId)?.known;
    return known && this.now() - known.at < PRICE_STALE_MS ? known.price : undefined;
  }

  /** Whether the minimum-profit check needs a market price: with the
   * user's own sell price it needs none. */
  private needsMarketEstimate(): boolean {
    return this.settings.thresholds.minProfit > 0 && this.settings.autoSell.mode !== 'fixed';
  }

  /** Starts the market-price lookups the minimum-profit check will read,
   * without waiting for any (a card looked up recently is not asked again). */
  private prefetchPrices(resourceIds: readonly number[]): void {
    if (!this.needsMarketEstimate()) return;
    for (const id of [...new Set(resourceIds)].slice(0, MAX_PREFETCH_PER_SEARCH)) void this.sellPrice(id);
  }

  /** What a card bought at `m.buyNow` is expected to sell for, and the
   * profit that leaves: the price auto-sell lists it at (`plannedSalePrice`),
   * so the profit a buy shows uses the price the user set rather than an
   * estimate they never chose. */
  private async estimate(m: SniperMatch): Promise<Estimate> {
    const a = this.settings.autoSell;
    return this.estimateAt(m, plannedSalePrice(a, a.mode === 'fixed' ? null : await this.sellPrice(m.resourceId)));
  }

  /** `estimate` from what is known now, never waiting: the user's own sell
   * price, or a market price whose lookup has answered. Null: unknown yet. */
  private knownEstimate(m: SniperMatch): Estimate | null {
    const a = this.settings.autoSell;
    const market = a.mode === 'fixed' ? null : this.knownSellPrice(m.resourceId);
    return market === undefined ? null : this.estimateAt(m, plannedSalePrice(a, market));
  }

  private estimateAt(m: SniperMatch, sellPrice: number | null): Estimate {
    return { sellPrice, profit: sellPrice == null ? null : profitAfterTax(sellPrice, m.buyNow) };
  }

  /** `autoSell` without holding up the bot. */
  private autoSellInBackground(m: SniperMatch): void {
    void this.autoSell(m).catch((err: unknown) => {
      this.addLog({ kind: 'blocked', resourceId: m.resourceId, assetId: m.assetId, rating: m.rating, message: `not listed: ${String(err)}` });
      this.deps.onChange();
    });
  }

  /** Auto-sell: list a card the bot just bought, at the user's price (the
   * market price moved by their steps, or their fixed price). Never throws;
   * whatever happens is in the log. */
  private async autoSell(m: SniperMatch): Promise<void> {
    const a = this.settings.autoSell;
    if (!a.enabled || this.deps.killSwitch().active) return;
    const card = { resourceId: m.resourceId, assetId: m.assetId, rating: m.rating };
    const notListed = (why: string) => void this.addLog({ kind: 'blocked', ...card, message: `not listed: ${why}` });

    let price: number;
    let basis: string;
    if (a.mode === 'fixed') {
      price = plannedSalePrice(a, null)!;
      basis = 'your fixed price';
    } else {
      const market = (await this.deps.marketPrice?.(m.resourceId, a.platform).catch(() => null)) ?? null;
      if (!market) return notListed('no market price for this card (FUTBIN and Nova have none)');
      price = plannedSalePrice(a, market.price)!;
      const steps = a.steps === 0 ? '' : `, ${a.steps > 0 ? '+' : ''}${a.steps} step${Math.abs(a.steps) === 1 ? '' : 's'}`;
      basis = `${market.source === 'futbin' ? 'FUTBIN' : 'Nova market'} price ${coins(market.price)}${steps}`;
    }
    if (a.noLoss && profitAfterTax(price, m.buyNow) < 0) {
      return notListed(`${coins(price)} would lose money after EA's 5% tax (bought for ${coins(m.buyNow)})`);
    }
    // Starting bid one step under the buy-now, as the web app suggests.
    const start = Math.max(MIN_START_PRICE, stepPrice(price, -1));
    const result = await this.deps.adapter.list(m.tradeId, start, price);
    if (result.ok) this.addLog({ kind: 'listed', ...card, price, message: basis });
    else notListed(result.error ?? 'EA did not accept the listing');
    this.deps.onChange();
  }

  /** Why a match was not bought, once per listing: the same one comes back
   * on every search until it sells or expires. */
  private logSkip(m: SniperMatch, why: string): void {
    if (this.skipped.has(m.tradeId)) return;
    this.skipped.add(m.tradeId);
    if (this.skipped.size > MAX_SKIPS_REMEMBERED) this.skipped.delete(this.skipped.values().next().value!);
    this.addLog({
      kind: 'blocked',
      resourceId: m.resourceId,
      assetId: m.assetId,
      rating: m.rating,
      price: m.buyNow,
      message: `skipped at ${coins(m.buyNow)}: ${why}`,
    });
  }

  /** Counts a buy at once. Its sell price and profit come from `known`
   * when the buy already had them, else they are filled in (with the
   * Profit figure and Top snipes) when the lookup answers. */
  private recordBought(m: SniperMatch, latencyMs: number, known: Estimate | null, timings: Timings = {}): void {
    this.stats.purchases++;
    this.stats.coinsSpent += m.buyNow;
    this.runTotals.purchases++;
    this.runTotals.coinsSpent += m.buyNow;
    const entry = this.addLog({
      kind: 'bought',
      resourceId: m.resourceId,
      assetId: m.assetId,
      rating: m.rating,
      price: m.buyNow,
      sellPrice: known?.sellPrice ?? null,
      profit: known?.profit ?? null,
      reactionMs: timings.reactionMs,
      message: 'bought',
    });
    const settle = (e: Estimate) => {
      entry.sellPrice = e.sellPrice;
      entry.profit = e.profit;
      if (e.profit != null) this.stats.profit += e.profit;
      this.recordTopSnipe(entry);
    };
    if (known) settle(known);
    else
      void this.estimate(m).then((e) => {
        settle(e);
        this.deps.onChange();
      });
    this.deps.onAttempt?.({
      ...this.attemptBase(m),
      ...timings,
      outcome: 'success',
      latencyMs,
      errorCode: null,
    });
    this.deps.onTrade?.({ tradeId: m.tradeId, resourceId: m.resourceId, buyPrice: m.buyNow });
  }

  private attemptBase(
    m: SniperMatch,
  ): Pick<AttemptInput, 'resourceId' | 'tradeId' | 'targetPrice' | 'listedPrice'> {
    return {
      resourceId: m.resourceId,
      tradeId: m.tradeId,
      targetPrice: m.buyNow,
      listedPrice: m.buyNow,
    };
  }

  /** The lower of the filter's max price and the page's max buy price. */
  private priceCap(filter: FilterCriteria): number | null {
    const caps = [filter.maxPrice, this.settings.thresholds.maxBuyPrice || undefined].filter(
      (n): n is number => n != null && n > 0,
    );
    return caps.length > 0 ? Math.min(...caps) : null;
  }

  /** Guards against listings that reached the page from somewhere other than
   * this search (the user searching by hand while the bot runs). */
  private matches(a: TrimmedAuction, f: FilterCriteria, cap: number | null): boolean {
    if (a.buyNow <= 0) return false;
    // The adapter said up front it could not buy this one (it has not seen
    // the item entity its service shape buys on): it would only refuse.
    if (a.buyable === false) return false;
    if (cap != null && a.buyNow > cap) return false;
    // A player target holds EA's base player id; a special version of that
    // player has its own resourceId but the same assetId.
    if (f.resourceId != null && a.resourceId !== f.resourceId && a.assetId !== f.resourceId)
      return false;
    if (f.minRating != null && a.rating < f.minRating) return false;
    if (f.maxRating != null && a.rating > f.maxRating) return false;
    if (a.expiresAt != null && a.expiresAt <= this.now()) return false;
    return true;
  }

  /** Drops what has left a one-hour window; returns how many are left. */
  private inWindow(times: number[]): number {
    const cutoff = this.now() - ONE_HOUR_MS;
    while (times.length > 0 && times[0]! <= cutoff) times.shift();
    return times.length;
  }

  /** 0 when another action fits in the window, else ms until one does:
   * when enough of the oldest have left it to bring the count under `limit`. */
  private windowWait(times: number[], limit: number): number {
    const n = this.inWindow(times);
    if (n < limit) return 0;
    return times[n - limit]! + ONE_HOUR_MS - this.now();
  }

  /** The last hour's searches and buys, for the governor's buy:search ratio. */
  private ratioCounts(): RatioCounts {
    return { searches: this.inWindow(this.searchTimes), buys: this.inWindow(this.buyTimes) };
  }

  /** The bot's governor, on the user's limits; its buy:search ratio runs on
   * this file's own rolling windows (`ratioCounts`). */
  private newGovernor(state?: GovernorState): Governor {
    return new Governor(botGovernorSettings(this.settings), {
      now: this.now,
      bounds: BOT_GOVERNOR_BOUNDS,
      state,
      ratioCounts: () => this.ratioCounts(),
    });
  }

  /** Adds the current active stretch to today's total (starting a new day's
   * total at midnight) and saves it every so often, or now when `save`. */
  private accrueActive(save: boolean): void {
    const now = this.now();
    if (this.activeSince != null) {
      const today = localDay(now);
      if (today !== this.usage.day) {
        this.usage = { day: today, activeMs: 0 };
        this.activeSince = Math.max(this.activeSince, startOfLocalDay(now));
      }
      this.usage.activeMs = Math.min(86_400_000, this.usage.activeMs + (now - this.activeSince));
      this.activeSince = now;
    }
    if (save || now - this.usageSavedAt >= USAGE_SAVE_EVERY_MS) {
      this.usageSavedAt = now;
      this.deps.saveUsage?.({ day: this.usage.day, activeMs: Math.round(this.usage.activeMs) });
    }
  }

  /** Ends the current active stretch (a rest, or the bot stopping). */
  private pauseActive(save: boolean): void {
    this.accrueActive(save);
    this.activeSince = null;
  }

  private dailyLimitReached(): boolean {
    this.accrueActive(false);
    return this.usage.activeMs >= this.settings.safety.maxActiveHoursPerDay * ONE_HOUR_MS;
  }

  /** Stops the bot when the account can no longer be confirmed (signed
   * out, or unreachable), or else when the plan no longer includes it. */
  private applyEntitlement(): boolean {
    const accountIssue = this.deps.account?.() ?? null;
    if (accountIssue) {
      this.stop(accountIssue.reason, accountIssue.detail);
      return true;
    }
    if (!this.deps.entitled || this.deps.entitled()) return false;
    this.stop('not_entitled');
    return true;
  }

  /** Stops the bot when another EA tab holds the engine lease. */
  private applyExclusive(): boolean {
    if (!this.deps.exclusive || this.deps.exclusive()) return false;
    this.stop('other_tab');
    return true;
  }

  /** The hourly budgets as they stand, for `saveBudget`. */
  getBudget(): BotBudgetState | null {
    if (!this.governor) return null;
    const cutoff = this.now() - ONE_HOUR_MS;
    return {
      governor: this.governor.serialize(),
      searchTimes: this.searchTimes.filter((t) => t > cutoff),
      buyTimes: this.buyTimes.filter((t) => t > cutoff),
    };
  }

  private persistBudget(): void {
    // Until the saved budget is loaded, this governor is a fresh one: saving
    // it (a Stop pressed while `run()` still awaits `loadBudget`) would
    // overwrite the stored windows with empty ones and refill every budget.
    if (!this.budgetHydrated) return;
    // A tab that no longer holds the engine lease has a stale copy: another
    // tab has loaded, spent and saved the budgets since. Saving it (the
    // Stop that follows losing the lease) would drop that tab's actions
    // and refill them (review Q-I1).
    if (this.deps.exclusive && !this.deps.exclusive()) return;
    const budget = this.getBudget();
    if (budget) this.deps.saveBudget?.(budget);
  }

  /** Takes the saved budgets over (every start). The windows are merged
   * with anything this page already counted — a save of its own that never
   * reached storage must not be lost either — and the saved cooldown wins
   * if it is later. The kill switch is re-read before every action anyway,
   * so the saved flag is dropped. */
  private hydrateBudget(budget: BotBudgetState): void {
    const cutoff = this.now() - ONE_HOUR_MS;
    const inWindow = (t: number) => t > cutoff && t <= this.now();
    const saved = budget.governor;
    const mine = this.governor?.serialize();
    const coinFlow = mergeCounted(mine?.coinFlow ?? [], saved.coinFlow, (c) => `${c.at}:${c.coins}`)
      .filter((c) => inWindow(c.at))
      .sort((x, y) => x.at - y.at);
    const merge = (a: number[], b: number[]) =>
      mergeCounted(a, b, String).filter(inWindow).sort((x, y) => x - y);
    this.governor = this.newGovernor({
      ...saved,
      actionTimestamps: merge(mine?.actionTimestamps ?? [], saved.actionTimestamps),
      coinFlow,
      searchCount: Math.max(saved.searchCount, mine?.searchCount ?? 0),
      buyCount: Math.max(saved.buyCount, mine?.buyCount ?? 0),
      cooldownUntil: Math.max(saved.cooldownUntil, mine?.cooldownUntil ?? 0),
      killSwitchActive: false,
      killSwitchReason: undefined,
    });
    // The buy:search ratio reads these two windows, so it rolls with the
    // hour: a long history of searches cannot bank a burst of buys, and an
    // idle hour leaves nothing to start over.
    this.searchTimes = merge(this.searchTimes, budget.searchTimes);
    this.buyTimes = merge(this.buyTimes, budget.buyTimes);
  }

  private applyKillSwitch(): boolean {
    const ks = this.deps.killSwitch();
    this.governor?.setKillSwitch(ks.active, ks.reason);
    if (ks.active) {
      this.stop('kill_switch', ks.reason ?? STOP_MESSAGES.kill_switch);
      return true;
    }
    return false;
  }

  /** `endsAt`: what the page counts down to, when the wait is one step of a
   * longer one (`waitBlocked`). */
  private async wait(phase: SniperPhase, ms: number, signal: AbortSignal, endsAt = this.now() + ms): Promise<void> {
    this.setState({ phase, phaseEndsAt: endsAt, stopReason: null, stopDetail: null });
    const bucket = PACE_WAITS[phase];
    const from = this.now();
    try {
      await this.sleep(ms, signal);
    } finally {
      // The time it really waited, also when a stop cut the wait short.
      if (bucket) this.pace.waits[bucket] += Math.max(0, this.now() - from);
    }
  }

  private pickInt(r: { min: number; max: number }): number {
    return Math.floor(r.min + this.random() * (r.max - r.min + 1));
  }

  private pickSeconds(r: { min: number; max: number }): number {
    return r.min + this.random() * (r.max - r.min);
  }

  private setState(next: Omit<SniperState, 'notice'>): void {
    this.stateValue = { ...next, notice: this.buyBlock?.message ?? null };
    this.deps.onChange();
  }

  private addLog(entry: Omit<SniperLogEntry, 'id' | 'at'>): SniperLogEntry {
    const full: SniperLogEntry = { id: this.nextId++, at: this.now(), ...entry };
    this.log.unshift(full);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.length = MAX_LOG_ENTRIES;
    this.deps.onLog?.(full);
    return full;
  }

  /** `at`: when EA's answer came back (buying may have run since). */
  private addSearchResult(
    filterName: string,
    matches: SniperMatch[],
    listings: number,
    cheapest: number | null,
    at: number,
  ): void {
    const result: SniperSearchResult = { id: this.nextId++, at, filterName, matches, listings, cheapest };
    this.results.unshift(result);
    if (this.results.length > MAX_SEARCH_RESULTS) this.results.length = MAX_SEARCH_RESULTS;
    this.deps.onSearchResult?.(result);
  }

  private recordTopSnipe(entry: SniperLogEntry): void {
    if (entry.profit == null) return;
    const top = [...this.stats.topSnipes, entry].sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
    this.stats.topSnipes = top.slice(0, TOP_SNIPES);
  }
}

const STOP_MESSAGES: Record<SniperStopReason, string> = {
  manual: 'stopped by you',
  no_filters: 'no filters to search',
  kill_switch: 'the server kill switch is on',
  probe_failure: "EA's web app no longer looks the way the bot expects",
  shape_mismatch: "EA's market data changed shape",
  purchase_limit: 'purchase limit reached',
  coin_budget: 'coin budget spent',
  session_length: 'session length limit reached',
  daily_limit: 'active hours per day limit reached — the bot can run again tomorrow',
  risk_unacknowledged:
    'these settings are above low risk: confirm the risk on the Nova AI page first, or reset to recommended',
  not_entitled: 'your plan no longer includes Nova AI',
  signed_out: 'signed out of Nova Trade — sign in again to restart',
  account_unreachable: "Nova Trade could not confirm your account (it may be unreachable) — Start again once it's back",
  other_tab: 'Nova Trade is running in another EA tab: stop the bot there, or close that tab, first',
  budget_unavailable:
    'the saved hourly limits could not be read (the extension may be restarting) — try Start again in a moment',
  search_failing: 'searches keep failing',
  ea_session_ended: 'Your EA session ended — log in to the web app again',
  ea_verification: 'EA wants a verification (captcha) — solve it in the web app, then Start again',
  ea_rate_limited:
    'EA kept limiting searches (HTTP 429 / 512 / 521), so the bot stopped to protect your account from a transfer market ban — wait at least an hour, then Start again with a longer search delay',
};
