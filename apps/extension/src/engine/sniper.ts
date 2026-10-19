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
 *
 * Bid mode (`BotModeSettings`, picked before Start): the same engine runs a
 * second loop (`runBids`) instead of the search -> buy one, bidding on
 * auctions in their last minutes up to the search's max price, re-bidding
 * when outbid while the next bid stays at or under it, and buying with Buy
 * Now when that is at or under it (engine/bidder.ts has how it decides).
 * One engine, so one set of rails: the search delay, breaks, rests, active
 * hours a day, searches an hour, the kill switch, plan, account and engine
 * lease checks, and EA's rate-limit backoff, slow-down, rests and soft-ban
 * stop all apply to it unchanged. Its own: bids an hour (a sliding window,
 * `bidding.maxBidsPerHour`, every bid EA saw), which the governor's actions
 * an hour also counts (raised by that many in Bid mode); and the coins its
 * standing bids hold, which count against the session coin budget, the
 * coins EA says the trader has, and the governor's coin flow. It follows
 * its bids on the watch list, and refuses to run where Nova AI cannot read
 * it. What it wins is a purchase like any snipe (telemetry, sale tracking),
 * listed by auto-sell when that is on, else moved to the transfer list.
 */
import {
  BOT_GOVERNOR_BOUNDS,
  DEFAULT_BOT_MODE_SETTINGS,
  MAX_COIN_PRICE,
  MIN_SALE_PRICE,
  MIN_START_PRICE,
  botGovernorSettings,
  botRiskLevel,
  clampBotModeSettings,
  clampBotSettings,
  eaErrorCategory,
  roundToPriceStep,
  stepPrice,
} from '@sl/shared';

import { ACT_ERROR, isAdapterRefusal } from '../lib/act-auth.js';

import { BidBook, WATCHLIST_SIZE, nextBid, pickAuctions, timeLeft } from './bidder.js';
import { Governor } from './governor.js';
import { attemptErrorCode } from './types.js';

import type { BidEvent, BidPick, TrackedBid } from './bidder.js';
import type { GovernorDecision, GovernorState, RatioCounts, RiskBudgetEventInput } from './governor.js';
import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';
import type {
  AdapterEaError,
  BotBudgetState,
  BotDailyUsage,
  BotMode,
  BotModeSettings,
  BotPace,
  BotSettings,
  FilterCriteria,
  GovernorSettings,
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
    if (status === '429') return 'EA says too many requests (error 429): slow the bot down';
    if (status === '512' || status === '521') return `EA is temporarily limiting your account (error ${status}): slow the bot down`;
    return `EA refused it (error ${status})`;
  }
  if (error === ACT_ERROR.priceMismatch) return 'the price changed';
  if (error === ACT_ERROR.listingUnknown || error === ACT_ERROR.listingEntityUnknown) return 'the listing was gone';
  if (error === ACT_ERROR.resourceMismatch) return 'a different card was listed';
  if (error === ACT_ERROR.unauthenticated) return 'Nova AI lost its link to the page: reload it';
  if (/timed out/i.test(error)) return 'EA did not answer in time';
  return 'EA did not accept the buy';
}

/** Why a bid was not accepted, in the user's words (like `missReason`). EA's
 * codes on a bid as traders report them: 461 / 478 when someone else's bid
 * (or buy) got there first or the auction ended. */
export function bidMissReason(error: string | undefined): string {
  if (!error) return 'EA did not say why';
  const status = /status (\d{3})/.exec(error)?.[1];
  if (status === '403' || status === '461' || status === '478') return 'someone else bid first, or the auction ended';
  if (status) return missReason(error);
  if (error === ACT_ERROR.priceMismatch) return 'the bid had changed';
  if (error === ACT_ERROR.listingUnknown) return 'the auction had ended';
  if (error === ACT_ERROR.listingEntityUnknown) return 'Nova AI had not seen this auction in its own search';
  if (error === ACT_ERROR.biddingUnsupported) return 'this EA web app does not let Nova AI bid';
  const reason = missReason(error);
  return reason === 'EA did not accept the buy' ? 'EA did not accept the bid' : reason;
}

/** Why a won card was not moved to the transfer list, in the user's words. */
export function moveMissReason(error: string | undefined): string {
  if (error === 'move_unsupported') return 'Nova AI cannot move cards on this EA web app';
  if (error === 'move_not_bought') return 'Nova AI did not win it on this page load';
  const status = error ? /status (\d{3})/.exec(error)?.[1] : undefined;
  if (status) return `EA refused the move (error ${status}): your transfer list may be full`;
  if (error && /timed out/i.test(error)) return 'EA did not answer in time';
  return 'EA did not move it';
}

/** What an EA rate limit or server error means, for the bot's log. */
export function eaErrorText(status: number | string): string {
  const code = String(status);
  if (code === '429') return 'EA says too many requests (error 429)';
  if (code === '512' || code === '521') return `EA is temporarily limiting your searches (error ${code})`;
  return `EA's servers had a problem (error ${code})`;
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

/** A coin amount as the log writes it in a sentence: "12,250". */
function amount(n: number): string {
  return n.toLocaleString('en-US');
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

/** Takes one entry at `at` back out of a sliding window. */
function dropTime(times: number[], at: number): void {
  const i = times.lastIndexOf(at);
  if (i !== -1) times.splice(i, 1);
}

/** An auction as a match a buy (or the profit check, at `price`) works on. */
function bidMatch(
  a: { tradeId: string; resourceId: number; assetId: number; rating: number; expiresAt: number | null },
  price: number,
): SniperMatch {
  return { tradeId: a.tradeId, resourceId: a.resourceId, assetId: a.assetId, rating: a.rating, buyNow: price, expiresAt: a.expiresAt };
}

/** A Bid mode pick as the search results show it, and as a buy takes it. */
function pickMatch(p: BidPick): SniperMatch {
  const m = bidMatch(p.auction, p.auction.buyNow);
  return p.action === 'bid' ? { ...m, bid: p.price } : m;
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
  /** Bid mode: placing a bid. */
  | 'bidding'
  /** Bid mode: reading the watch list to follow its bids. */
  | 'checking'
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
  | 'ea_rate_limited'
  /** Bid mode: the search has no max price, which is its max bid. */
  | 'no_max_bid'
  /** Bid mode: the page cannot bid or read the watch list for Nova AI. */
  | 'bid_unavailable'
  /** Bid mode: the watch list could not be read, again and again. */
  | 'watchlist_failing'
  /** Bid mode: EA's watch list is full and no bid is left to follow. */
  | 'watchlist_full';

export interface SniperLogEntry {
  id: number;
  at: number;
  /** `listed`: auto-sell put a bought card on the market (`price` is its
   * buy-now, `message` how that price was chosen). Bid mode adds `bid` (a
   * bid or re-bid went in), `won`, `moved` (a won card went to the transfer
   * list) and `dropped` (an auction the bot stopped bidding on, or lost).
   * A message that names the card says `{card}` where the page puts its
   * name. */
  kind: 'bought' | 'listed' | 'failed' | 'blocked' | 'info' | 'bid' | 'won' | 'moved' | 'dropped';
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
  /** A second line under the message, when it needs one. */
  detail?: string;
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
  /** Bid mode: the bid it would take (absent: bought with Buy Now). */
  bid?: number;
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
  /** Which limit: the attempt's `errorCode`, and what tells two blocks apart.
   * `bids_per_hour`: Bid mode's own window. */
  code: 'coin_flow' | 'buys_per_hour' | 'buy_search_ratio' | 'actions_per_hour' | 'bids_per_hour';
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

/** What a buy needs of the search that found its listing: when it went out
 * and when each listing arrived (the timings). */
type SearchTimes = Pick<SearchRun, 'sentAt' | 'arrivedAt'>;

/** A Bid mode search's answer (`Sniper.bidSearch`). */
type BidSearch =
  | ({ ok: true; at: number; auctions: TrimmedAuction[] } & SearchTimes)
  | { ok: false; error: string; at: number };

/** The breaks and rests between searches, for either mode's loop. */
interface Pacing {
  searchesSinceBreak: number;
  nextBreakAfter: number;
  restAt: number;
}

/** How a bid went (`Sniper.placeBid`): `placed` (it went in, or may have),
 * `skipped` (not this one: `why` says, when the user should hear it),
 * `dropped` (a limit holds bidding back: no more bids this cycle), or
 * `stopped`. */
type BidEnd = { end: 'placed' } | { end: 'skipped'; why?: string } | { end: 'dropped' } | { end: 'stopped' };

/** What a bid is on: an auction from a search, or one of the bot's own
 * open bids (a re-bid). */
interface BidTarget {
  tradeId: string;
  resourceId: number;
  assetId: number;
  rating: number;
  startingBid: number;
  currentBid: number;
  buyNow: number;
  expiresAt: number;
  maxBid: number;
  itemId: string | null;
}

/** Bid mode's watch list reads: at most every WATCH_MIN_GAP_MS, at least
 * every WATCH_MAX_AGE_MS while bids are open, and every cycle (within the
 * gap) once a bid ends within WATCH_NEAR_MS, is outbid or has no answer
 * yet (`Sniper.watchlistDue`). */
const WATCH_MIN_GAP_MS = 15_000;
const WATCH_MAX_AGE_MS = 60_000;
const WATCH_NEAR_MS = 90_000;
/** Failed watch list reads in a row before Bid mode gives up. */
const MAX_WATCH_FAILURES_IN_A_ROW = 3;

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
  /** `bid`, `watchlist` and `move` are Bid mode's: without the first two it
   * refuses to start in Bid mode (`bid_unavailable`). */
  adapter: Pick<AdapterClient, 'search' | 'buy' | 'list' | 'onAuctions' | 'onBuyable' | 'onProbe' | 'onShape'> &
    Partial<Pick<AdapterClient, 'onEaError' | 'bid' | 'watchlist' | 'move'>>;
  getFilters: () => SniperFilter[];
  /** The coin balance EA's own answers last stated (null: none seen). Bid
   * mode bids only what it leaves after the coins its other bids hold.
   * Omitted = unknown. */
  credits?: () => number | null;
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

  /** Snipe or Bid and Bid mode's settings (clamped into `BID_LIMITS`), and
   * the mode the current (or last) start runs: a change applies at the next
   * Start. */
  private modeSettings: BotModeSettings;
  private runMode: BotMode = 'snipe';
  /** Bid mode: the sliding one-hour window of bids EA saw. */
  private bidTimes: number[] = [];
  /** Bid mode: the auctions holding one of the bot's bids. Kept across
   * Stop/Start: EA keeps the bids until their auctions end, and the next
   * start in Bid mode follows them again. */
  private readonly book = new BidBook();
  /** Bid mode's watch list: when it was last read, failed reads in a row,
   * how many auctions it holds, and whether "it is full" has been said. */
  private watch = { at: -Infinity, failures: 0, size: 0, fullNoted: false };
  /** What the last watch list read said, for `settleBids`. */
  private bidEvents: BidEvent[] = [];

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly deps: SniperDeps,
    settings: BotSettings,
    modeSettings: BotModeSettings = DEFAULT_BOT_MODE_SETTINGS,
  ) {
    this.settings = clampBotSettings(settings);
    this.modeSettings = clampBotModeSettings(modeSettings);
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
    this.addLog({ kind: 'blocked', message: `${eaErrorText(error.status)}: waiting ${Math.round(stepMs / 1000)} s before the next search` });
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
      message: `EA limited your searches ${EA_LIMITS_BEFORE_REST} times in ${EA_LIMIT_WINDOW_MS / 60_000} minutes (error ${status}): resting ${restMs / 60_000} min to protect your account, then searching at a third of your normal speed`,
    });
    this.slowDown(this.eaBackoff.until, false);
    this.deps.onChange();
    return true;
  }

  /** Searches slower until `EA_SLOW_MS` after `from` (the end of the wait),
   * saying so (`announce`) when it was searching at full speed. */
  private slowDown(from: number, announce = true): void {
    const wasSlow = this.now() < this.eaSlowUntil;
    this.eaSlowUntil = Math.max(this.eaSlowUntil, from + EA_SLOW_MS);
    if (!wasSlow && announce) {
      const speed = this.eaPaceFactor() === 3 ? 'a third of your normal speed' : 'half your normal speed';
      this.addLog({
        kind: 'info',
        message: `Searching at ${speed} for the next ${EA_SLOW_MS / 60_000} minutes so EA's limit can reset`,
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
    this.governor?.setSettings(this.governorSettings(), BOT_GOVERNOR_BOUNDS);
    // Settings raised above low while running, with no acknowledgment: the
    // same rule as start(), enforced here, not only on the page.
    if (this.isRunning() && this.riskUnacknowledged()) this.stop('risk_unacknowledged');
  }

  /** Snipe or Bid, and Bid mode's settings. The mode applies at the next
   * Start; Bid mode's limits apply at once. */
  setModeSettings(modeSettings: BotModeSettings): void {
    this.modeSettings = clampBotModeSettings(modeSettings);
    this.governor?.setSettings(this.governorSettings(), BOT_GOVERNOR_BOUNDS);
  }

  getModeSettings(): BotModeSettings {
    return this.modeSettings;
  }

  /** The mode the bot runs (or last ran). */
  getRunMode(): BotMode {
    return this.runMode;
  }

  /** While Bid mode runs: its open bids out of the user's max, and the
   * coins they hold. Null otherwise. */
  getBidStatus(): { active: number; max: number; committed: number } | null {
    if (!this.isRunning() || this.runMode !== 'bid') return null;
    return { active: this.book.size(), max: this.modeSettings.bidding.maxActiveBids, committed: this.book.committed() };
  }

  /** The governor's thresholds: the user's own (`botGovernorSettings`),
   * with Bid mode's bids an hour added to the actions an hour while it
   * runs — every bid is a request EA sees, and the bids' own window holds
   * them to their limit. */
  private governorSettings(): GovernorSettings {
    const g = botGovernorSettings(this.settings);
    if (this.runMode !== 'bid') return g;
    return { ...g, actionsPerHour: g.actionsPerHour + this.modeSettings.bidding.maxBidsPerHour };
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
    const mode = this.modeSettings.mode;
    if (mode === 'bid') {
      // Bid mode follows its bids on the watch list: without the calls for
      // that it never starts (and the first read must work, `runBids`).
      // The max price is the max bid: without one there is no limit.
      const reason: SniperStopReason | null =
        !this.deps.adapter.bid || !this.deps.adapter.watchlist
          ? 'bid_unavailable'
          : filters.some((f) => this.priceCap(f.filter) == null)
            ? 'no_max_bid'
            : null;
      if (reason) {
        this.setState({ phase: 'stopped', phaseEndsAt: null, stopReason: reason, stopDetail: STOP_MESSAGES[reason] });
        return;
      }
    }
    this.runMode = mode;
    this.abort = new AbortController();
    this.budgetHydrated = false;
    // One governor for the life of this object: Stop/Start keeps its
    // windows (and the search/buy windows below) rather than refilling them.
    if (this.governor) {
      this.governor.setSettings(this.governorSettings(), BOT_GOVERNOR_BOUNDS);
    } else {
      this.governor = this.newGovernor();
    }
    this.watch = { at: -Infinity, failures: 0, size: 0, fullNoted: false };
    this.bidEvents = [];
    this.buyBlock = null;
    this.stats.startedAt = this.now();
    this.runTotals = { purchases: 0, coinsSpent: 0 };
    this.pace = newPaceWindow(this.now());
    this.filterIndex = 0;
    this.searchRounds.clear();
    // The sell prices the minimum-profit check reads, looked up now so the
    // first matches find them: a buy never waits for one.
    this.prefetchPrices(filters.map((f) => f.filter.resourceId).filter((id): id is number => id != null));
    if (mode === 'bid') {
      const b = this.modeSettings.bidding;
      this.addLog({
        kind: 'info',
        message: `Bot started in Bid mode: bids on auctions with ${plural(b.windowMinutes, 'minute')} or less left, up to ${plural(b.maxActiveBids, 'bid')} at a time, never above your max price`,
      });
    } else this.addLog({ kind: 'info', message: 'Bot started' });
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
    // EA keeps a bid until its auction ends: say so, rather than let the
    // user think stopping took them back.
    const open = this.runMode === 'bid' ? this.book.size() : 0;
    if (open > 0)
      this.addLog({
        kind: 'info',
        message: `${plural(open, 'bid')} still open: EA keeps bids until their auctions end, and Bid mode follows them again when you start it`,
      });
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
    const pacing = this.newPacing();
    if (!(await this.loadRunState(signal))) return;
    return this.runMode === 'bid' ? this.runBids(signal, pacing) : this.runSnipes(signal, pacing);
  }

  /** Today's active time and the saved hourly budgets, before anything
   * acts. False when the bot stopped meanwhile, or could not read the
   * budgets (it then stops). */
  private async loadRunState(signal: AbortSignal): Promise<boolean> {
    const saved = await this.deps.loadUsage?.().catch(() => null);
    if (signal.aborted) return false;
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
        if (!signal.aborted) this.stop('budget_unavailable');
        return false;
      }
      if (signal.aborted) return false;
      if (budget) this.hydrateBudget(budget);
    }
    this.budgetHydrated = true;
    return true;
  }

  private newPacing(): Pacing {
    return {
      searchesSinceBreak: 0,
      nextBreakAfter: this.pickInt(this.settings.breaks.searches),
      restAt: this.now() + this.pickInt(this.settings.rest.afterMinutes) * 60_000,
    };
  }

  /** Takes the rest or the break that is due, if any. True when it took
   * one (or the bot stopped during it): the loop then starts over. */
  private async takeBreakIfDue(p: Pacing, signal: AbortSignal): Promise<boolean> {
    const s = this.settings;
    if (s.rest.enabled && this.now() >= p.restAt) {
      const restMs = this.pickInt(s.rest.minutes) * 60_000;
      this.pauseActive(true);
      await this.wait('rest', restMs, signal);
      if (signal.aborted) return true;
      this.activeSince = this.now();
      p.restAt = this.now() + this.pickInt(this.settings.rest.afterMinutes) * 60_000;
      return true;
    }
    if (s.breaks.enabled && p.searchesSinceBreak >= p.nextBreakAfter) {
      await this.wait('break', this.pickInt(s.breaks.seconds) * 1000, signal);
      p.searchesSinceBreak = 0;
      p.nextBreakAfter = this.pickInt(this.settings.breaks.searches);
      return true;
    }
    return false;
  }

  /** Snipe mode: search, buy what is at or under the price cap, wait. */
  private async runSnipes(signal: AbortSignal, p: Pacing): Promise<void> {
    const s = () => this.settings;
    let failuresInRow = 0;

    while (!signal.aborted) {
      if (this.dailyLimitReached()) return this.stop('daily_limit');
      if (await this.takeBreakIfDue(p, signal)) continue;

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
      p.searchesSinceBreak++;
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
    const gate = await this.searchWindowGate(signal, false);
    return gate === 'skip' ? 'wait' : gate;
  }

  /** The user's searches-per-hour window and the governor, for a search
   * about to go out. `following` (Bid mode, with bids to follow): a full
   * search window skips this cycle's search rather than sleeping, so the
   * bids are still followed. */
  private async searchWindowGate(signal: AbortSignal, following: boolean): Promise<'go' | 'skip' | 'wait' | 'stopped'> {
    const searchWait = this.windowWait(this.searchTimes, this.settings.safety.maxSearchesPerHour);
    if (searchWait > 0) {
      if (following) return 'skip';
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
      if (this.buyBlock && this.blockLifted(this.buyBlock)) this.endBlock();
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

  /** Whether the budget holding buying (or bidding) back has room again,
   * once a search has been allowed. Snipe mode only gets here after
   * `searchPause` found the buy window and the coin flow free, so for it
   * this is the ratio check alone; Bid mode, which bids on its own windows,
   * checks each. */
  private blockLifted(b: BuyBlock): boolean {
    if (b.code === 'buy_search_ratio') return this.governor!.ratioAllowsBuy();
    if (b.code === 'bids_per_hour') return this.windowWait(this.bidTimes, this.modeSettings.bidding.maxBidsPerHour) === 0;
    if (b.code === 'buys_per_hour') return this.windowWait(this.buyTimes, this.settings.safety.maxBuysPerHour) === 0;
    if (b.code === 'coin_flow' && b.coins != null) {
      const at = this.governor!.coinFlowFreesAt(b.coins);
      return at == null || at <= this.now();
    }
    return true;
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

  /** `verb`: what the limit holds back ("Bidding" for a bid, whose standing
   * bids count in the coin flow). */
  private coinFlowBlock(price: number, resumeAt: number, verb = 'Buying'): BuyBlock {
    const { coinFlowLastHour: flow, coinFlowLimit: limit } = this.governor!.snapshot();
    return {
      code: 'coin_flow',
      kind: 'coin_flow',
      value: flow + price,
      threshold: limit,
      resumeAt,
      coins: price,
      message: `${verb} paused: coin-flow limit (${flow.toLocaleString('en-US')} of ${coins(limit)} in the last hour) — resumes about ${clockTime(resumeAt)}`,
    };
  }

  private bidsPerHourBlock(waitMs: number): BuyBlock {
    const limit = this.modeSettings.bidding.maxBidsPerHour;
    const n = this.bidTimes.length;
    const resumeAt = this.now() + waitMs;
    return {
      code: 'bids_per_hour',
      kind: 'actions_per_hour',
      value: n + 1,
      threshold: limit,
      resumeAt,
      message: `Bidding paused: bid limit (${n} of ${plural(limit, 'bid')} in the last hour) — resumes about ${clockTime(resumeAt)}`,
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
    const what = this.runMode === 'bid' ? plural(limit, 'search, bid and buy', 'searches, bids and buys') : plural(limit, 'search and buy', 'searches and buys');
    return {
      code: 'actions_per_hour',
      kind: 'actions_per_hour',
      value: event?.value ?? n + 1,
      threshold: limit,
      resumeAt,
      message: `Paused: safety limit of ${what} an hour (${n} in the last hour) — resumes about ${clockTime(resumeAt)}`,
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
    search: SearchTimes,
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
    dropTime(this.buyTimes, at);
  }

  // ---- Bid mode -------------------------------------------------------------

  /** Bid mode's loop (engine/bidder.ts has how it decides). Each cycle: the
   * watch list when a bid needs it, then what it said (collect what was
   * won, re-bid where outbid while the max allows, else drop), then a
   * search for more auctions while there is room. Paced like Snipe mode —
   * the search delay start to start, slower after EA limits it, breaks
   * every N searches, rests — and under every limit it has. */
  private async runBids(signal: AbortSignal, p: Pacing): Promise<void> {
    let failuresInRow = 0;
    // Bid mode follows its bids on the watch list: where Nova AI cannot
    // read it, it places none (fail closed). The read is a request EA sees,
    // so it waits on the same checks as any other.
    if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return;
    if ((await this.waitOutEaBackoff(signal)) && signal.aborted) return;
    if (!(await this.readWatchlist(signal, true))) return;

    while (!signal.aborted) {
      if (this.dailyLimitReached()) return this.stop('daily_limit');
      if (await this.takeBreakIfDue(p, signal)) continue;
      const filters = this.deps.getFilters();
      if (filters.length === 0) return this.stop('no_filters');
      // The search can be edited while the bot runs; its max price is the max bid.
      if (filters.some((f) => this.priceCap(f.filter) == null)) return this.stop('no_max_bid');
      if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return;
      if (await this.waitOutEaBackoff(signal)) continue;
      const startedAt = this.now();

      if (this.watchlistDue(startedAt) && !(await this.readWatchlist(signal, false))) return;
      if ((await this.settleBids(signal)) === 'stopped') return;
      if (this.watchlistFull()) return this.stop('watchlist_full');

      if (this.bidRoom() > 0) {
        // With bids to follow, a full search window skips the search
        // rather than sleeping through their last minutes.
        const gate = await this.searchWindowGate(signal, this.book.size() > 0);
        if (gate === 'stopped') return;
        if (gate === 'wait') continue;
        if (gate === 'go') {
          const target = filters[this.filterIndex++ % filters.length]!;
          const found = await this.bidSearch(target);
          if (signal.aborted) return;
          this.stats.searches++;
          this.searchSeq++;
          p.searchesSinceBreak++;
          this.pace.searches++;
          if (!found.ok) {
            this.pace.failed++;
            if (!this.eaExcused(found.error, startedAt)) failuresInRow++;
            this.addLog({ kind: 'failed', message: `Search "${target.name}" failed: ${found.error}` });
            if (failuresInRow >= MAX_SEARCH_FAILURES_IN_A_ROW) return this.stop('search_failing');
          } else {
            failuresInRow = 0;
            this.pace.searchMs.push(found.at - startedAt);
            if (found.auctions.length > 0) this.pace.withResults++;
            if ((await this.takeAuctions(target, found, signal)) === 'stopped') return;
          }
        }
      }
      this.deps.onChange();

      const delayMs = this.pickSeconds(this.settings.searchDelay) * 1000 * this.eaPaceFactor();
      await this.wait('waiting', Math.max(0, delayMs - (this.now() - startedAt)), signal);
    }
  }

  /** How many more auctions Bid mode may bid on now: the user's max open
   * bids, and room on EA's watch list. */
  private bidRoom(): number {
    const open = this.modeSettings.bidding.maxActiveBids - this.book.size();
    return Math.max(0, Math.min(open, WATCHLIST_SIZE - this.watch.size));
  }

  /** EA's watch list is full: a new bid would not fit. True when no bid of
   * the bot's is left on it to follow (the bot then stops); otherwise it
   * says so once, and bids again once there is room (`bidRoom`). */
  private watchlistFull(): boolean {
    if (this.watch.size < WATCHLIST_SIZE) {
      this.watch.fullNoted = false;
      return false;
    }
    if (this.book.size() === 0) return true;
    if (!this.watch.fullNoted) {
      this.watch.fullNoted = true;
      this.addLog({
        kind: 'blocked',
        message: `Your EA watch list is full (${WATCHLIST_SIZE} cards): no new bids until there is room. Clear expired items in EA's Transfer Targets`,
      });
    }
    return false;
  }

  /** Whether this cycle reads the watch list: only while bids are open, at
   * most every WATCH_MIN_GAP_MS, at least every WATCH_MAX_AGE_MS, and every
   * cycle (within that gap) once a bid ends within WATCH_NEAR_MS, was
   * outbid or has no answer yet. */
  private watchlistDue(now: number): boolean {
    const bids = this.book.bids();
    if (bids.length === 0) return false;
    const age = now - this.watch.at;
    if (age < WATCH_MIN_GAP_MS) return false;
    if (age >= WATCH_MAX_AGE_MS) return true;
    return bids.some((b) => b.state !== 'leading' || b.expiresAt - now <= WATCH_NEAR_MS);
  }

  /** Reads the watch list, and keeps what it said for `settleBids`. False
   * when the bot stopped: the page cannot read it for Nova AI
   * (`bid_unavailable`), the first read failed (Bid mode does not start
   * without one), reads keep failing, or EA ended the session. EA limiting
   * requests backs off as it does for a search, never a stop by itself. */
  private async readWatchlist(signal: AbortSignal, first: boolean): Promise<boolean> {
    this.setState({ phase: 'checking', phaseEndsAt: null, stopReason: null, stopDetail: null });
    const startedAt = this.now();
    this.watch.at = startedAt;
    const res = await this.deps.adapter.watchlist!();
    if (signal.aborted) return false;
    if (res.ok) {
      this.watch.failures = 0;
      const watched = res.watched ?? [];
      this.watch.size = watched.length;
      this.bidEvents.push(...this.book.reconcile(watched, this.now()));
      return true;
    }
    const error = res.error ?? 'unknown error';
    if (error === ACT_ERROR.biddingUnsupported) {
      this.stop('bid_unavailable');
      return false;
    }
    // The adapter's own minimum gap between reads: nothing new to read yet.
    if (error === 'watchlist_too_soon') return true;
    this.addLog({ kind: 'failed', message: `Could not read your watch list: ${error}` });
    if (this.watchlistEaError(error, startedAt)) return this.isRunning();
    this.watch.failures++;
    if (first || this.watch.failures >= MAX_WATCH_FAILURES_IN_A_ROW) {
      this.stop('watchlist_failing');
      return false;
    }
    return true;
  }

  /** EA's status in a failed watch list read, handled as the adapter's
   * `ea_error` is for a search (it files none for the watch list's own
   * request): an ended session or a captcha stops the bot, a rate limit or
   * an outage backs off (`eaExcused`). True when it was one of those. */
  private watchlistEaError(error: string, startedAt: number): boolean {
    const status = Number(/status (\d{3})/.exec(error)?.[1]);
    if (!Number.isInteger(status)) return false;
    const category = eaErrorCategory(status);
    if (category === 'session_ended' || category === 'verification') {
      this.onEaError({ status, category, endpoint: 'market', seenAt: this.now() });
      return true;
    }
    return this.eaExcused(error, startedAt);
  }

  /** What the last watch list read said about the bot's bids. A won auction
   * is a purchase (`onWon`); a lost one, or one that left the list, gives
   * its coins back; an outbid one gives its coins back (EA did) and is
   * re-bid or dropped, soonest-ending first. */
  private async settleBids(signal: AbortSignal): Promise<'done' | 'stopped'> {
    const events = this.bidEvents;
    this.bidEvents = [];
    for (const e of events) {
      if (e.kind === 'won') this.onWon(e.bid, e.price);
      else if (e.kind === 'lost')
        this.dropBid(e.bid, { message: 'Lost {card} to a higher bid', detail: e.price > 0 ? `it went for ${amount(e.price)}` : undefined, outcome: 'too_slow', errorCode: 'outbid' });
      else if (e.kind === 'gone') this.dropBid(e.bid, { message: 'Stopped following {card}: it is no longer on your watch list' });
      else this.releaseBid(e.bid);
    }
    if (signal.aborted) return 'stopped';
    for (const e of events) {
      if (e.kind !== 'outbid' || !this.book.get(e.bid.tradeId)) continue;
      const r = await this.rebid(e.bid, signal);
      if (r === 'stopped') return 'stopped';
      // A limit holds bidding back: the rest wait for the next read.
      if (r === 'dropped') break;
    }
    return 'done';
  }

  /** An open bid that was outbid: re-bid the next step while that stays at
   * or under the max and under the buy-now price, else drop the auction.
   * One whose buy-now price is at or under the max is bought instead. */
  private async rebid(b: TrackedBid, signal: AbortSignal): Promise<'done' | 'dropped' | 'stopped'> {
    // Ended: the next read says whether it was won.
    if (b.expiresAt <= this.now()) return 'done';
    if (b.buyNow > 0 && b.buyNow <= b.maxBid) {
      this.book.close(b.tradeId);
      const end = await this.buyMatches([bidMatch(b, b.buyNow)], { sentAt: this.now(), arrivedAt: () => undefined }, new Set(), signal);
      return end === 'stopped' ? 'stopped' : 'done';
    }
    const next = nextBid(b);
    if (next > b.maxBid || (b.buyNow > 0 && next >= b.buyNow)) {
      this.dropBid(b, {
        message: 'Max bid reached on {card} — dropping it',
        detail: `the next bid would be ${amount(next)}, your max is ${amount(b.maxBid)}`,
        errorCode: 'max_bid_reached',
      });
      return 'done';
    }
    const r = await this.placeBid(b, next, b, signal);
    if (r.end === 'stopped' || r.end === 'dropped') return r.end;
    if (r.end === 'skipped' && r.why) this.dropBid(b, { message: 'Not re-bidding on {card} — dropping it', detail: r.why, errorCode: 'rebid_skipped' });
    return 'done';
  }

  /** One Bid mode search: auctions whose current bid is at most the max
   * (EA's own `maxBid` criterion, stepped down EA's grid like Snipe mode's
   * max buy-now price so EA never answers it from its cache), whatever
   * their buy-now price. Waits for EA's answer: an auction's last minutes
   * are not a race to the millisecond the way a snipe is. */
  private async bidSearch(target: SniperFilter): Promise<BidSearch> {
    this.setState({ phase: 'searching', phaseEndsAt: null, stopReason: null, stopDetail: null });
    const cap = this.priceCap(target.filter)!;
    const collected = new Map<string, TrimmedAuction>();
    const arrived = new Map<string, number>();
    const take = (a: TrimmedAuction): void => {
      collected.set(a.tradeId, a);
      if (a.buyable !== false && !arrived.has(a.tradeId)) arrived.set(a.tradeId, this.now());
    };
    const off = this.deps.adapter.onAuctions((raw) => {
      for (const a of raw as TrimmedAuction[]) take(a);
    });
    const offBuyable = this.deps.adapter.onBuyable((tradeIds) => {
      for (const id of tradeIds) {
        const a = collected.get(id);
        if (a) take({ ...a, buyable: true });
      }
    });
    const round = this.searchRounds.get(target.id) ?? 0;
    this.searchRounds.set(target.id, round + 1);
    // Not by buy-now price: an auction worth bidding on is one whose
    // buy-now price is over the max.
    const criteria: FilterCriteria = { ...target.filter };
    delete criteria.maxPrice;
    const maxBid = Math.max(MIN_START_PRICE, searchMaxBuy(round, undefined, cap)!);
    const sentAt = this.now();
    this.searchTimes.push(sentAt);
    const searching = this.deps.adapter.search(criteria, { maxBid });
    // Saved once the search is on its way, not before it.
    this.persistBudget();
    let outcome: Awaited<typeof searching>;
    try {
      outcome = await searching;
    } finally {
      off();
      offBuyable();
    }
    const at = this.now();
    if (!outcome.ok) return { ok: false, error: outcome.error ?? 'unknown error', at };
    return { ok: true, at, auctions: [...collected.values()], sentAt, arrivedAt: (tradeId) => arrived.get(tradeId) };
  }

  /** A Bid mode search's auctions (`pickAuctions`): buys first, through
   * Snipe mode's own buy path and limits, then bids, soonest-ending first,
   * while there is room. */
  private async takeAuctions(target: SniperFilter, found: Extract<BidSearch, { ok: true }>, signal: AbortSignal): Promise<'done' | 'stopped'> {
    const maxBid = this.priceCap(target.filter)!;
    const picks = pickAuctions(found.auctions, {
      now: this.now(),
      windowMs: this.modeSettings.bidding.windowMinutes * 60_000,
      maxBid,
      filter: target.filter,
      skip: (tradeId) => this.book.knows(tradeId),
    });
    const prices = found.auctions.map((a) => a.buyNow).filter((n) => n > 0);
    this.addSearchResult(target.name, picks.map(pickMatch), found.auctions.length, prices.length ? Math.min(...prices) : null, found.at);
    this.prefetchPrices(found.auctions.map((a) => a.resourceId));
    const buys = picks.filter((pick) => pick.action === 'buy').map(pickMatch);
    if (buys.length > 0) {
      const end = await this.buyMatches(buys, found, new Set(), signal);
      if (end === 'stopped') return 'stopped';
      // A pause after a buy left the rest stale, or a limit holds buying back.
      if (end === 'dropped') return 'done';
    }
    for (const pick of picks) {
      if (pick.action !== 'bid') continue;
      if (this.bidRoom() <= 0) break;
      const a = pick.auction;
      const auction: BidTarget = {
        tradeId: a.tradeId,
        resourceId: a.resourceId,
        assetId: a.assetId,
        rating: a.rating,
        startingBid: a.startingBid,
        currentBid: a.currentBid,
        buyNow: a.buyNow,
        expiresAt: a.expiresAt!,
        maxBid,
        itemId: a.itemId ?? null,
      };
      const r = await this.placeBid(auction, pick.price, null, signal);
      if (r.end === 'stopped') return 'stopped';
      if (r.end === 'dropped') break;
      if (r.end === 'skipped' && r.why) this.logBidSkip(auction, pick.price, r.why);
    }
    return 'done';
  }

  /**
   * One bid, through every check of a buy that applies to one: the kill
   * switch, plan, account and lease; EA's backoff; the minimum profit; the
   * session coin budget and the coins EA says the trader has, both net of
   * what the bot's other bids hold; the bids-per-hour window; and the
   * governor (actions an hour, and the coin flow with every standing bid in
   * it). `rebid`: the bot's own open bid on this auction, outbid.
   */
  private async placeBid(t: BidTarget, bid: number, rebid: TrackedBid | null, signal: AbortSignal): Promise<BidEnd> {
    this.setState({ phase: 'bidding', phaseEndsAt: null, stopReason: null, stopDetail: null });
    if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return { end: 'stopped' };
    // EA is limiting requests or erroring: the next cycle waits it out.
    if (this.eaBackoff.until > this.now()) return { end: 'dropped' };
    const th = this.settings.thresholds;
    if (th.minProfit > 0) {
      const estimate = this.knownEstimate(bidMatch(t, bid));
      if (estimate?.profit != null && estimate.profit < th.minProfit)
        return { end: 'skipped', why: `estimated profit ${coins(estimate.profit)} is under your minimum profit (${coins(th.minProfit)})` };
    }
    const held = this.book.committed();
    if (th.sessionCoinBudget > 0 && this.runTotals.coinsSpent + held + bid > th.sessionCoinBudget) {
      if (this.runTotals.coinsSpent >= th.sessionCoinBudget) {
        this.stop('coin_budget');
        return { end: 'stopped' };
      }
      return {
        end: 'skipped',
        why: held > 0 ? `it would go over your session coin budget (${coins(held)} are held in your other bids)` : 'it would go over your session coin budget',
      };
    }
    // EA's own stated balance. Whether it already leaves out what the bot's
    // bids hold is unverified (day-one checklist): counting them again can
    // only skip a bid EA would have taken, never send one it refuses.
    const credits = this.deps.credits?.() ?? null;
    if (credits != null && held + bid > credits)
      return { end: 'skipped', why: `not enough coins (${coins(Math.max(0, credits - held))} free after your other bids)` };
    const bidWait = this.windowWait(this.bidTimes, this.modeSettings.bidding.maxBidsPerHour);
    if (bidWait > 0) {
      this.noteBlock(this.bidsPerHourBlock(bidWait), null);
      return { end: 'dropped' };
    }
    const decision = this.governor!.allow({ kind: 'bid', coins: bid });
    if (!decision.allowed) {
      this.persistBudget(); // a hard stop's cooldown is part of the budget
      if (decision.reason === 'kill_switch') {
        this.stop('kill_switch', decision.detail);
        return { end: 'stopped' };
      }
      if (decision.reason === 'coin_flow') {
        const at = this.governor!.coinFlowFreesAt(bid);
        if (at == null) return { end: 'skipped', why: `it is more than your coins per hour (${coins(this.settings.safety.maxCoinFlowPerHour)})` };
        this.noteBlock(this.coinFlowBlock(bid, at, 'Bidding'), null);
        return { end: 'dropped' };
      }
      this.noteBlock(this.actionsBlock(decision), null);
      return { end: 'dropped' };
    }
    if (this.buyBlock && this.blockLifted(this.buyBlock)) this.endBlock();

    // Counted in the bid window now, and taken back below only if the
    // adapter refused it before it reached EA.
    const at = this.now();
    this.bidTimes.push(at);
    const bidding = this.deps.adapter.bid!(t.tradeId, bid, { resourceId: t.resourceId, assetId: t.assetId });
    // Saved once the bid is on its way, not before it.
    this.persistBudget();
    const result = await bidding;
    const card = { resourceId: t.resourceId, assetId: t.assetId, rating: t.rating, price: bid };
    if (result.ok || result.error === ACT_ERROR.timeoutUnknown || !result.signed) {
      // In, or perhaps in (EA did not answer in time, or no signed answer
      // came): it holds its coins until the watch list says otherwise, and
      // a bid that never landed leaves the book after two reads without it.
      const tracked: TrackedBid = rebid ?? { ...t, amount: bid, state: 'pending', decision: null, missing: 0 };
      if (!rebid) this.watch.size++;
      tracked.amount = bid;
      tracked.state = result.ok ? 'leading' : 'pending';
      tracked.decision = decision;
      tracked.missing = 0;
      this.book.place(tracked);
      if (result.ok)
        this.addLog({
          kind: 'bid',
          ...card,
          message: rebid ? `Outbid on {card} — re-bidding ${amount(bid)}` : `Bid ${amount(bid)} on {card} (${timeLeft(t.expiresAt - at)})`,
        });
      else this.addLog({ kind: 'failed', ...card, message: `No answer from EA in time for the ${amount(bid)} bid on {card}: the next watch list check will tell` });
      this.deps.onChange();
      // Kept in the book even when the bot stopped meanwhile: EA holds it.
      return signal.aborted ? { end: 'stopped' } : { end: 'placed' };
    }
    // A signed answer that it did not go in. An adapter refusal never
    // reached EA: everything it took comes back. EA's own refusal gives its
    // coins back and stays a request EA saw (and a bid in the hour).
    if (isAdapterRefusal(result.error)) {
      this.governor!.refund(decision);
      dropTime(this.bidTimes, at);
    } else this.governor!.releaseSpend(decision);
    if (rebid) rebid.decision = null;
    this.book.close(t.tradeId);
    this.stats.failures++;
    this.addLog({ kind: 'failed', ...card, message: `${rebid ? 'Re-bid' : 'Bid'} ${amount(bid)} on {card} not accepted: ${bidMissReason(result.error)}` });
    this.deps.onAttempt?.({
      resourceId: t.resourceId,
      tradeId: t.tradeId,
      targetPrice: bid,
      listedPrice: t.currentBid || t.startingBid || null,
      outcome: missOutcome(result.error),
      latencyMs: result.latencyMs,
      errorCode: attemptErrorCode(result.error),
    });
    this.deps.onChange();
    return signal.aborted ? { end: 'stopped' } : { end: 'skipped' };
  }

  /** An auction the bot won: a purchase like a snipe (the counters, its
   * profit, the attempt and the trade report the sale tracking follows),
   * then off the watch list (`collectWon`). Its coins stay spent in the
   * coin flow. */
  private onWon(b: TrackedBid, price: number): void {
    const m = bidMatch(b, price > 0 ? price : b.amount);
    this.recordBought(m, null, this.knownEstimate(m), {}, { itemId: b.itemId });
    void this.collectWon(m).catch((err: unknown) => {
      this.addLog({ kind: 'blocked', resourceId: m.resourceId, assetId: m.assetId, rating: m.rating, message: `{card} stays in your watch list: ${String(err)}` });
      this.deps.onChange();
    });
    const t = this.settings.thresholds;
    if (t.stopAfterPurchases > 0 && this.runTotals.purchases >= t.stopAfterPurchases) this.stop('purchase_limit');
  }

  /** A won card off the watch list, without holding up the bot: moved to
   * the transfer list (through EA's own call), then listed by auto-sell at
   * the same price a sniped card gets when it is on. Where it cannot be
   * moved it stays in the watch list, as EA leaves it. Never throws for EA's
   * answers: every outcome is in the log. */
  private async collectWon(m: SniperMatch): Promise<void> {
    const card = { resourceId: m.resourceId, assetId: m.assetId, rating: m.rating };
    const moved = this.deps.adapter.move ? await this.deps.adapter.move(m.tradeId) : { ok: false, error: 'move_unsupported', latencyMs: 0 };
    if (!moved.ok) {
      this.addLog({ kind: 'blocked', ...card, message: `{card} stays in your watch list: ${moveMissReason(moved.error)}` });
      this.deps.onChange();
      return;
    }
    this.watch.size = Math.max(0, this.watch.size - 1);
    if (this.settings.autoSell.enabled && !this.deps.killSwitch().active) return this.autoSell(m);
    this.addLog({ kind: 'moved', ...card, message: 'Moved {card} to your transfer list' });
    this.deps.onChange();
  }

  /** An outbid bid's coins back: EA gave them back. */
  private releaseBid(b: TrackedBid): void {
    if (b.decision) this.governor?.releaseSpend(b.decision);
    b.decision = null;
  }

  /** The bot stops bidding on one of its auctions (or lost it). It stays on
   * the watch list as EA keeps it (engine/bidder.ts says why), its coins
   * come back, and with an `errorCode` it counts as a miss. */
  private dropBid(
    b: TrackedBid,
    o: { message: string; detail?: string; errorCode?: string; outcome?: Extract<SnipeOutcome, 'too_slow' | 'failed'> },
  ): void {
    this.releaseBid(b);
    this.book.close(b.tradeId);
    this.addLog({ kind: 'dropped', resourceId: b.resourceId, assetId: b.assetId, rating: b.rating, price: b.amount, message: o.message, detail: o.detail });
    if (o.errorCode) {
      this.stats.failures++;
      this.deps.onAttempt?.({
        resourceId: b.resourceId,
        tradeId: b.tradeId,
        targetPrice: b.amount,
        listedPrice: b.currentBid || null,
        outcome: o.outcome ?? 'failed',
        latencyMs: null,
        errorCode: o.errorCode,
      });
    }
    this.deps.onChange();
  }

  /** Why an auction was not bid on, once per auction (like `logSkip`). */
  private logBidSkip(t: BidTarget, bid: number, why: string): void {
    const remembered = `bid:${t.tradeId}`;
    if (this.skipped.has(remembered)) return;
    this.skipped.add(remembered);
    if (this.skipped.size > MAX_SKIPS_REMEMBERED) this.skipped.delete(this.skipped.values().next().value!);
    this.addLog({ kind: 'blocked', resourceId: t.resourceId, assetId: t.assetId, rating: t.rating, price: bid, message: `not bidding ${coins(bid)}: ${why}` });
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
   * Profit figure and Top snipes) when the lookup answers. `won`: an
   * auction Bid mode won (`m.buyNow` is the winning bid), with the item id
   * the watch list gave for the sale tracking. */
  private recordBought(
    m: SniperMatch,
    latencyMs: number | null,
    known: Estimate | null,
    timings: Timings = {},
    won?: { itemId: string | null },
  ): void {
    this.stats.purchases++;
    this.stats.coinsSpent += m.buyNow;
    this.runTotals.purchases++;
    this.runTotals.coinsSpent += m.buyNow;
    const entry = this.addLog({
      kind: won ? 'won' : 'bought',
      resourceId: m.resourceId,
      assetId: m.assetId,
      rating: m.rating,
      price: m.buyNow,
      sellPrice: known?.sellPrice ?? null,
      profit: known?.profit ?? null,
      reactionMs: timings.reactionMs,
      message: won ? `Won {card} for ${amount(m.buyNow)}` : 'bought',
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
    this.deps.onTrade?.({
      tradeId: m.tradeId,
      resourceId: m.resourceId,
      buyPrice: m.buyNow,
      ...(won ? { itemId: won.itemId, assetId: m.assetId, rating: m.rating } : {}),
    });
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
    return new Governor(this.governorSettings(), {
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
      bidTimes: this.bidTimes.filter((t) => t > cutoff),
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
    this.bidTimes = merge(this.bidTimes, budget.bidTimes ?? []);
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
    'EA kept limiting your searches after two rests: your account is likely soft banned (EA has blocked transfer market searches for a while). Do not search for a few hours, then Start again with a longer search delay',
  no_max_bid: 'set a max price in Search first: in Bid mode it is the most Nova AI bids for a player',
  bid_unavailable:
    "Bid mode needs to bid and read your watch list through EA's web app, and this page does not let Nova AI do that — use Snipe mode",
  watchlist_failing:
    'Nova AI could not read your EA watch list, which Bid mode needs to follow its bids — try Start again in a moment',
  watchlist_full:
    "your EA watch list is full: clear the expired items in EA's Transfer Targets, then Start again",
};
