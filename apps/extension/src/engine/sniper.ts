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
 *   - max coins per hour and the buy:search ratio, through the governor;
 *   - the cooldown after every buy.
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
  MIN_SALE_PRICE,
  MIN_START_PRICE,
  botGovernorSettings,
  botRiskLevel,
  clampBotSettings,
  roundToPriceStep,
  stepPrice,
} from '@sl/shared';

import { ACT_ERROR, isAdapterRefusal } from '../lib/act-auth.js';

import { Governor } from './governor.js';

import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';
import type {
  BotBudgetState,
  BotDailyUsage,
  BotSettings,
  FilterCriteria,
  TrimmedAuction,
} from '@sl/shared';

/** EA keeps 5% of every sale. */
const EA_TAX = 0.05;
const MAX_LOG_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const TOP_SNIPES = 5;
/** Consecutive failed searches before the bot gives up. */
const MAX_SEARCH_FAILURES_IN_A_ROW = 5;
/** How far up a search's price range its min buy-now price may step to
 * keep the search fresh (`searchMinBuy`), as a share of the range. */
const FRESH_SEARCH_SHARE = 0.4;
/** The same, in coins, for a search with no max price. */
const FRESH_SEARCH_SPAN_UNCAPPED = 1_000;

/**
 * The min buy-now price for a target's `round`th search (0 first).
 *
 * EA answers a search it was just asked, word for word, from its cache
 * (traders sniping by hand and community autobuyers both work around
 * this): a bot sending the same search every few seconds kept getting the
 * same results back, and saw a new listing only after other buyers had
 * had it. So each search steps the min buy-now price one notch up EA's
 * price grid from the bottom of the search's range (the filter's own min,
 * or none), starting over once it would pass 40% of the way to the max
 * price: every search in a cycle asks EA something it was not just asked.
 * Only listings far under the max price are left out, and only by some of
 * the searches in each cycle.
 */
export function searchMinBuy(round: number, minPrice: number | undefined, cap: number | null): number | undefined {
  const floor = minPrice ?? 0;
  const top = cap != null ? floor + (cap - floor) * FRESH_SEARCH_SHARE : floor + FRESH_SEARCH_SPAN_UNCAPPED;
  const prices: (number | undefined)[] = [minPrice];
  let p = minPrice != null ? stepPrice(minPrice, 1) : MIN_START_PRICE;
  while (p <= top) {
    prices.push(p);
    const next = stepPrice(p, 1);
    if (next <= p) break;
    p = next;
  }
  return prices[round % prices.length];
}
/** Shortest wait when the governor refuses a search, so a denied loop never spins. */
const MIN_BLOCKED_WAIT_MS = 5_000;
/** How long a card's sell-price estimate is reused (`Sniper.sellPrice`). */
const PRICE_TTL_MS = 120_000;
const MAX_CACHED_PRICES = 500;
const MAX_SKIPS_REMEMBERED = 500;

/** A listing's estimated sell price and profit after EA's tax (null: unknown). */
interface Estimate {
  sellPrice: number | null;
  profit: number | null;
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
  | 'not_entitled'
  | 'other_tab'
  | 'budget_unavailable'
  | 'search_failing';

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
}

export interface SniperDeps {
  adapter: Pick<AdapterClient, 'search' | 'buy' | 'list' | 'onAuctions' | 'onBuyable' | 'onProbe' | 'onShape'>;
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
  /** Sliding one-hour windows of search and buy times. */
  private searchTimes: number[] = [];
  private buyTimes: number[] = [];
  /** Sell-price estimates by resourceId (`sellPrice`). */
  private prices = new Map<number, { at: number; value: Promise<number | null> }>();
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
  private stateValue: SniperState = {
    phase: 'idle',
    phaseEndsAt: null,
    stopReason: null,
    stopDetail: null,
  };
  private readonly log: SniperLogEntry[] = [];
  private readonly results: SniperSearchResult[] = [];
  private nextId = 1;
  private filterIndex = 0;
  /** Searches sent for each filter (by id) since the bot started, for
   * `searchMinBuy`. */
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
    deps.adapter.onShape((reason) => {
      if (this.isRunning()) this.stop('shape_mismatch', reason);
    });
  }

  // ---- public surface ---------------------------------------------------

  get state(): SniperState {
    return this.stateValue;
  }

  getStats(): SniperStats {
    return this.stats;
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
      this.governor = new Governor(botGovernorSettings(this.settings), {
        now: this.now,
        bounds: BOT_GOVERNOR_BOUNDS,
      });
    }
    this.freshRatioIfIdle();
    this.stats.startedAt = this.now();
    this.runTotals = { purchases: 0, coinsSpent: 0 };
    this.filterIndex = 0;
    this.searchRounds.clear();
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
      const target = filters[this.filterIndex++ % filters.length]!;

      const gate = await this.searchGate(signal);
      if (gate === 'stopped') return;
      if (gate === 'wait') continue;

      // The search delay runs from this search's start to the next one's,
      // so the time EA takes to answer, and any buying, come out of it
      // rather than being added on top: the same pace, less dead time.
      const startedAt = this.now();
      const found = await this.searchOnce(target);
      if (signal.aborted) return;
      this.stats.searches++;
      searchesSinceBreak++;
      if (!found.ok) {
        failuresInRow++;
        this.addLog({ kind: 'failed', message: `Search "${target.name}" failed: ${found.error}` });
        if (failuresInRow >= MAX_SEARCH_FAILURES_IN_A_ROW) return this.stop('search_failing');
      } else {
        failuresInRow = 0;
        this.addSearchResult(target.name, found.matches, found.listings, found.cheapest);
        if (found.matches.length > 0) {
          this.setState({ phase: 'buying', phaseEndsAt: null, stopReason: null, stopDetail: null });
          if (await this.buyMatches(found.matches, signal, found.at)) return;
        }
      }
      this.deps.onChange();

      const delayMs = this.pickSeconds(s().searchDelay) * 1000;
      await this.wait('waiting', Math.max(0, delayMs - (this.now() - startedAt)), signal);
    }
  }

  /** Whether a search may go out now: the kill switch, plan and engine
   * lease, the user's searches-per-hour window and the governor. `wait`:
   * it waited out a limit, so the loop starts over. */
  private async searchGate(signal: AbortSignal): Promise<'go' | 'wait' | 'stopped'> {
    if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return 'stopped';
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
    if (decision.allowed) return 'go';
    this.persistBudget(); // a hard stop's cooldown is part of the budget
    if (decision.reason === 'kill_switch') {
      this.stop('kill_switch', decision.detail);
      return 'stopped';
    }
    if (decision.detail?.startsWith('session_length')) {
      this.stop('session_length');
      return 'stopped';
    }
    this.addLog({ kind: 'blocked', message: `Search paused by safety limits (${decision.detail ?? decision.reason})` });
    await this.wait('blocked', Math.max(this.governor!.snapshot().cooldownRemainingMs, MIN_BLOCKED_WAIT_MS), signal);
    return signal.aborted ? 'stopped' : 'wait';
  }

  /** One search through the adapter, and what it found at or under the
   * price cap, cheapest first. `at`: when EA's answer came back. */
  private async searchOnce(
    target: SniperFilter,
  ): Promise<
    | { ok: true; matches: SniperMatch[]; at: number; listings: number; cheapest: number | null }
    | { ok: false; error: string; at: number }
  > {
    this.setState({ phase: 'searching', phaseEndsAt: null, stopReason: null, stopDetail: null });
    const cap = this.priceCap(target.filter);
    const collected = new Map<string, TrimmedAuction>();
    const off = this.deps.adapter.onAuctions((raw) => {
      for (const a of raw as TrimmedAuction[]) collected.set(a.tradeId, a);
    });
    // When the search's network response reaches the adapter before its
    // own search call returns, the listings arrive marked unbuyable (no
    // item entity yet), and the call's result only upgrades them
    // (main/adapter.ts, isSecondSighting): without this, that search
    // would buy nothing.
    const offBuyable = this.deps.adapter.onBuyable((tradeIds) => {
      for (const id of tradeIds) {
        const a = collected.get(id);
        if (a) collected.set(id, { ...a, buyable: true });
      }
    });
    // Warm the estimate for the card this filter targets while EA
    // searches, so a match does not wait for it.
    if (this.settings.thresholds.minProfit > 0 && target.filter.resourceId != null)
      void this.sellPrice(target.filter.resourceId);
    const round = this.searchRounds.get(target.id) ?? 0;
    this.searchRounds.set(target.id, round + 1);
    const criteria: FilterCriteria = { ...target.filter };
    if (cap != null) criteria.maxPrice = cap;
    const minBuy = searchMinBuy(round, target.filter.minPrice, cap);
    if (minBuy != null) criteria.minPrice = minBuy;
    this.searchTimes.push(this.now());
    this.persistBudget();
    const outcome = await this.deps.adapter.search(criteria);
    const at = this.now();
    off();
    offBuyable();
    if (!outcome.ok) return { ok: false, error: outcome.error ?? 'unknown error', at };
    const prices = [...collected.values()].map((a) => a.buyNow).filter((p) => p > 0);
    const matches = [...collected.values()]
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
    return { ok: true, matches, at, listings: collected.size, cheapest: prices.length ? Math.min(...prices) : null };
  }

  /** Returns true when the bot stopped while buying. `searchedAt`: when
   * the search that found `matches` came back, so a missed buy can say how
   * long it took to send. */
  private async buyMatches(matches: SniperMatch[], signal: AbortSignal, searchedAt: number): Promise<boolean> {
    const t = this.settings.thresholds;
    // Every listing's estimate starts now, side by side, before any buy: a
    // buy then waits for one lookup at most, and none waits for the last
    // buy's.
    for (const m of matches) void this.sellPrice(m.resourceId);
    for (const m of matches) {
      if (signal.aborted) return true;

      if (t.sessionCoinBudget > 0 && this.runTotals.coinsSpent + m.buyNow > t.sessionCoinBudget) {
        if (this.runTotals.coinsSpent >= t.sessionCoinBudget) {
          this.stop('coin_budget');
          return true;
        }
        this.logSkip(m, 'it would go over your session coin budget');
        continue; // a cheaper listing may still fit
      }

      // Only the minimum-profit check needs the estimate before buying.
      // Without one the buy goes first (a listing this cheap is gone in
      // moments) and the estimate is looked up afterwards, for the log.
      let estimate: Estimate | null = null;
      if (t.minProfit > 0) {
        estimate = await this.estimate(m);
        // Unknown profit is allowed: the user capped the price, and the
        // ledger may simply not have seen this card sell yet.
        if (estimate.profit != null && estimate.profit < t.minProfit) {
          this.logSkip(
            m,
            `estimated profit ${coins(estimate.profit)} is under your minimum profit (${coins(t.minProfit)})`,
          );
          continue;
        }
      }

      if (this.applyKillSwitch() || this.applyEntitlement() || this.applyExclusive()) return true;
      if (this.windowWait(this.buyTimes, this.settings.safety.maxBuysPerHour) > 0) {
        this.addLog({
          kind: 'blocked',
          resourceId: m.resourceId,
          assetId: m.assetId,
          rating: m.rating,
          price: m.buyNow,
          message: `Buy skipped: ${this.buyTimes.length} buys in the last hour (your limit)`,
        });
        return false;
      }
      const decision = this.governor!.allow({ kind: 'buy', coins: m.buyNow });
      this.persistBudget();
      if (!decision.allowed) {
        this.deps.onAttempt?.({
          ...this.attemptBase(m),
          outcome: 'blocked',
          latencyMs: null,
          errorCode: decision.reason ?? 'blocked',
        });
        this.addLog({
          kind: 'blocked',
          resourceId: m.resourceId,
          assetId: m.assetId,
          rating: m.rating,
          price: m.buyNow,
          message: `Buy blocked by safety limits (${decision.detail ?? decision.reason})`,
        });
        if (decision.reason === 'kill_switch') {
          this.stop('kill_switch', decision.detail);
          return true;
        }
        if (decision.reason === 'hard_stop') return false;
        continue;
      }

      this.buyTimes.push(this.now());
      this.persistBudget();
      // The resourceId binds the buy to the card this filter targets: the
      // adapter refuses it unless the listing it saw for this tradeId is
      // that card (a forged `auctions` message can claim any tradeId).
      const sentAfterMs = this.now() - searchedAt;
      const result = await this.deps.adapter.buy(m.tradeId, m.buyNow, {
        resourceId: m.resourceId,
        assetId: m.assetId,
      });
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
          message: 'no answer from EA in time — it may still have bought; waiting for its answer',
        });
        this.deps.onAttempt?.({
          ...this.attemptBase(m),
          outcome: 'attempted',
          latencyMs: result.latencyMs,
          errorCode: ACT_ERROR.timeoutUnknown,
        });
        void result.late?.then(async (late) => {
          if (!late.ok) return;
          const { sellPrice, profit } = estimate ?? (await this.estimate(m));
          this.recordBought(m, sellPrice, profit, late.latencyMs);
          // Shown now, not at the next search (the bot may have stopped).
          this.deps.onChange();
          await this.autoSell(m);
        });
        if (signal.aborted) return true;
        this.deps.onChange();
        continue;
      }
      if (signal.aborted && !result.ok) return true;
      if (result.ok) {
        const { sellPrice, profit } = estimate ?? (await this.estimate(m));
        this.recordBought(m, sellPrice, profit, result.latencyMs);
        await this.autoSell(m);
        if (t.stopAfterPurchases > 0 && this.runTotals.purchases >= t.stopAfterPurchases) {
          this.stop('purchase_limit');
          return true;
        }
        const cooldownMs = this.settings.safety.cooldownSeconds * 1000;
        if (cooldownMs > 0) {
          await this.wait('cooldown', cooldownMs, signal);
          if (signal.aborted) return true;
        }
      } else {
        // The adapter's own refusals (lib/act-auth.ts) never reached EA:
        // the governor and the hourly limit get back what this buy took.
        // Only a signed one — an unsigned outcome may hide a buy that
        // happened.
        if (result.signed && isAdapterRefusal(result.error)) {
          this.governor!.refund(decision);
          this.buyTimes.pop();
          this.persistBudget();
        }
        this.stats.failures++;
        this.addLog({
          kind: 'failed',
          resourceId: m.resourceId,
          assetId: m.assetId,
          rating: m.rating,
          price: m.buyNow,
          // Where a miss's time went: our side (search back -> buy sent)
          // and EA's (buy sent -> answer).
          message: `${result.error ?? 'buy failed'} (sent ${sentAfterMs} ms after the search came back; EA answered in ${result.latencyMs} ms)`,
        });
        this.deps.onAttempt?.({
          ...this.attemptBase(m),
          outcome: 'failed',
          latencyMs: result.latencyMs,
          errorCode: result.error ?? 'unknown_error',
        });
      }
      this.deps.onChange();
    }
    return false;
  }

  // ---- helpers --------------------------------------------------------------

  /** The sell-price estimate for a card, shared by every listing of it for
   * PRICE_TTL_MS: a filter keeps finding the same card, and each lookup is a
   * round trip to the service worker that a buy would otherwise wait on. */
  private sellPrice(resourceId: number): Promise<number | null> {
    const now = this.now();
    const hit = this.prices.get(resourceId);
    if (hit && now - hit.at < PRICE_TTL_MS) return hit.value;
    const value = this.deps.estimateSellPrice(resourceId).catch(() => null);
    this.prices.set(resourceId, { at: now, value });
    if (this.prices.size > MAX_CACHED_PRICES) this.prices.delete(this.prices.keys().next().value!);
    return value;
  }

  /** What a card bought at `m.buyNow` is expected to sell for, and the
   * profit that leaves: the price auto-sell lists it at (`plannedSalePrice`),
   * so the profit a buy shows, and the minimum-profit check, use the price
   * the user set rather than an estimate they never chose. */
  private async estimate(m: SniperMatch): Promise<Estimate> {
    const sellPrice = await this.plannedSalePrice(m);
    return { sellPrice, profit: sellPrice == null ? null : Math.floor(sellPrice * (1 - EA_TAX)) - m.buyNow };
  }

  /** The user's own sell price when they set one (even with auto-sell off:
   * it is the price they said they sell at), else the market price, moved
   * by auto-sell's steps when auto-sell lists the card. The same price
   * `autoSell` lists at. */
  private async plannedSalePrice(m: SniperMatch): Promise<number | null> {
    const a = this.settings.autoSell;
    if (a.mode === 'fixed') return Math.max(MIN_SALE_PRICE, roundToPriceStep(a.fixedPrice));
    const market = await this.sellPrice(m.resourceId);
    if (market == null) return null;
    return a.enabled ? Math.max(MIN_SALE_PRICE, stepPrice(market, a.steps)) : market;
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
      price = roundToPriceStep(a.fixedPrice);
      basis = 'your fixed price';
    } else {
      const market = (await this.deps.marketPrice?.(m.resourceId, a.platform).catch(() => null)) ?? null;
      if (!market) return notListed('no market price for this card (FUTBIN and Nova have none)');
      price = stepPrice(market.price, a.steps);
      const steps = a.steps === 0 ? '' : `, ${a.steps > 0 ? '+' : ''}${a.steps} step${Math.abs(a.steps) === 1 ? '' : 's'}`;
      basis = `${market.source === 'futbin' ? 'FUTBIN' : 'Nova market'} price ${coins(market.price)}${steps}`;
    }
    price = Math.max(MIN_SALE_PRICE, price);
    if (a.noLoss && Math.floor(price * (1 - EA_TAX)) < m.buyNow) {
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

  private recordBought(m: SniperMatch, sellPrice: number | null, profit: number | null, latencyMs: number): void {
    this.stats.purchases++;
    this.stats.coinsSpent += m.buyNow;
    this.runTotals.purchases++;
    this.runTotals.coinsSpent += m.buyNow;
    if (profit != null) this.stats.profit += profit;
    const entry = this.addLog({
      kind: 'bought',
      resourceId: m.resourceId,
      assetId: m.assetId,
      rating: m.rating,
      price: m.buyNow,
      sellPrice,
      profit,
      message: 'bought',
    });
    this.recordTopSnipe(entry);
    this.deps.onAttempt?.({
      ...this.attemptBase(m),
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

  /** 0 when another action fits in the window, else ms until one does. */
  private windowWait(times: number[], limit: number): number {
    const now = this.now();
    while (times.length > 0 && times[0]! <= now - ONE_HOUR_MS) times.shift();
    if (times.length < limit) return 0;
    return times[0]! + ONE_HOUR_MS - now;
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

  /** Stops the bot when the user's plan no longer includes it. */
  private applyEntitlement(): boolean {
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
    this.governor = new Governor(botGovernorSettings(this.settings), {
      now: this.now,
      bounds: BOT_GOVERNOR_BOUNDS,
      state: {
        ...saved,
        actionTimestamps: merge(mine?.actionTimestamps ?? [], saved.actionTimestamps),
        coinFlow,
        searchCount: Math.max(saved.searchCount, mine?.searchCount ?? 0),
        buyCount: Math.max(saved.buyCount, mine?.buyCount ?? 0),
        cooldownUntil: Math.max(saved.cooldownUntil, mine?.cooldownUntil ?? 0),
        killSwitchActive: false,
        killSwitchReason: undefined,
      },
    });
    this.searchTimes = merge(this.searchTimes, budget.searchTimes);
    this.buyTimes = merge(this.buyTimes, budget.buyTimes);
    this.freshRatioIfIdle();
  }

  /** The governor's buy:search ratio counts since its session began, and
   * the bot's governor session never expires on its own. Carried across
   * starts for good, a long history of searches would let a burst of buys
   * through, so the counts start over — but only once the last hour holds
   * no action at all, when the hourly windows are empty anyway and there is
   * nothing to refill. */
  private freshRatioIfIdle(): void {
    const g = this.governor;
    if (g && g.snapshot().actionsLastHour === 0) g.resetSession();
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

  private async wait(phase: SniperPhase, ms: number, signal: AbortSignal): Promise<void> {
    this.setState({ phase, phaseEndsAt: this.now() + ms, stopReason: null, stopDetail: null });
    await this.sleep(ms, signal);
  }

  private pickInt(r: { min: number; max: number }): number {
    return Math.floor(r.min + this.random() * (r.max - r.min + 1));
  }

  private pickSeconds(r: { min: number; max: number }): number {
    return r.min + this.random() * (r.max - r.min);
  }

  private setState(next: SniperState): void {
    this.stateValue = next;
    this.deps.onChange();
  }

  private addLog(entry: Omit<SniperLogEntry, 'id' | 'at'>): SniperLogEntry {
    const full: SniperLogEntry = { id: this.nextId++, at: this.now(), ...entry };
    this.log.unshift(full);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.length = MAX_LOG_ENTRIES;
    this.deps.onLog?.(full);
    return full;
  }

  private addSearchResult(
    filterName: string,
    matches: SniperMatch[],
    listings: number,
    cheapest: number | null,
  ): void {
    const result: SniperSearchResult = { id: this.nextId++, at: this.now(), filterName, matches, listings, cheapest };
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
  other_tab: 'Nova Trade is running in another EA tab: stop the bot there, or close that tab, first',
  budget_unavailable:
    'the saved hourly limits could not be read (the extension may be restarting) — try Start again in a moment',
  search_failing: 'searches keep failing',
};
