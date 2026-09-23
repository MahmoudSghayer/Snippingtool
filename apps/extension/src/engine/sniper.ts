/*
 * sniper.ts — the Sniping Bot: an automatic search -> buy loop driven by the
 * user's saved filters and the pacing on the Sniping Bot page
 * (`ui/bot-page.ts`, `BotSettings` in @sl/shared).
 *
 * Each cycle searches the next filter, collects what came back, and buys
 * every listing at or under the price cap, cheapest first. Between searches
 * it waits a random delay from the user's range; every N searches it takes a
 * break; every N minutes it rests. All of those numbers are the user's to
 * choose, from very safe to very risky.
 *
 * What the user cannot turn off: every search and every buy still goes
 * through `governor.allow()` (with the thresholds from the page's Safety
 * limits), the server kill switch stops the loop, and so does an adapter
 * probe failure or market-shape change — acting on an EA app that no longer
 * looks the way `main/adapter.ts` expects is never safe.
 *
 * The bot runs its own governor, created fresh on every start from
 * `settings.safety`, so its session length counts from when the user pressed
 * Start.
 */
import { Governor } from './governor.js';

import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';
import type { BotSettings, FilterCriteria, TrimmedAuction } from '@sl/shared';

/** EA keeps 5% of every sale. */
const EA_TAX = 0.05;
const MAX_LOG_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const TOP_SNIPES = 5;
/** Consecutive failed searches before the bot gives up. */
const MAX_SEARCH_FAILURES_IN_A_ROW = 5;
/** Shortest wait when the governor refuses a search, so a denied loop never spins. */
const MIN_BLOCKED_WAIT_MS = 5_000;

export interface SniperFilter {
  id: string;
  name: string;
  filter: FilterCriteria;
}

export type SniperPhase = 'idle' | 'searching' | 'buying' | 'waiting' | 'break' | 'rest' | 'blocked' | 'stopped';

export type SniperStopReason =
  | 'manual'
  | 'no_filters'
  | 'kill_switch'
  | 'probe_failure'
  | 'shape_mismatch'
  | 'purchase_limit'
  | 'coin_budget'
  | 'session_length'
  | 'search_failing';

export interface SniperLogEntry {
  id: number;
  at: number;
  kind: 'bought' | 'failed' | 'blocked' | 'info';
  resourceId?: number;
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
  rating: number;
  buyNow: number;
  expiresAt: number | null;
}

export interface SniperSearchResult {
  id: number;
  at: number;
  filterName: string;
  matches: SniperMatch[];
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
  adapter: Pick<AdapterClient, 'search' | 'buy' | 'onAuctions' | 'onProbe' | 'onShape'>;
  getFilters: () => SniperFilter[];
  /** Expected resale price for a card, or null if the ledger has no data. */
  estimateSellPrice: (resourceId: number) => Promise<number | null>;
  /** The server kill switch as the content script currently knows it. */
  killSwitch: () => { active: boolean; reason?: string };
  onChange: () => void;
  onLog?: (entry: SniperLogEntry) => void;
  onSearchResult?: (result: SniperSearchResult) => void;
  onAttempt?: (input: AttemptInput) => void;
  onTrade?: (input: TradeInput) => void;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
  return { startedAt: null, searches: 0, purchases: 0, failures: 0, coinsSpent: 0, profit: 0, topSnipes: [] };
}

export class Sniper {
  private settings: BotSettings;
  private governor: Governor | null = null;
  private abort: AbortController | null = null;
  private stats: SniperStats = emptyStats();
  private stateValue: SniperState = { phase: 'idle', phaseEndsAt: null, stopReason: null, stopDetail: null };
  private readonly log: SniperLogEntry[] = [];
  private readonly results: SniperSearchResult[] = [];
  private nextId = 1;
  private filterIndex = 0;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly deps: SniperDeps,
    settings: BotSettings,
  ) {
    this.settings = settings;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? abortableSleep;
    deps.adapter.onProbe((status) => {
      if (!status.ok && this.isRunning()) this.stop('probe_failure', status.reason ?? 'EA app check failed');
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

  /** Takes effect from the next wait/break/rest; the safety limits apply to
   * the running governor straight away. */
  setSettings(settings: BotSettings): void {
    this.settings = settings;
    this.governor?.setSettings(settings.safety);
  }

  start(): void {
    if (this.isRunning()) return;
    const filters = this.deps.getFilters();
    if (filters.length === 0) {
      this.setState({ phase: 'stopped', phaseEndsAt: null, stopReason: 'no_filters', stopDetail: 'Add a filter to snipe first.' });
      return;
    }
    this.abort = new AbortController();
    this.governor = new Governor(this.settings.safety, { now: this.now });
    this.stats = { ...emptyStats(), startedAt: this.now() };
    this.filterIndex = 0;
    this.addLog({ kind: 'info', message: 'Bot started' });
    void this.run(this.abort.signal).catch((err) => this.stop('search_failing', String(err)));
  }

  stop(reason: SniperStopReason = 'manual', detail?: string): void {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = null;
    const message = detail ?? STOP_MESSAGES[reason];
    this.addLog({ kind: 'info', message: `Bot stopped: ${message}` });
    this.setState({ phase: 'stopped', phaseEndsAt: null, stopReason: reason, stopDetail: message });
  }

  /** Clears the counters, log and results (the page's reset button). */
  reset(): void {
    if (this.isRunning()) return;
    this.stats = emptyStats();
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

    while (!signal.aborted) {
      if (s().rest.enabled && this.now() >= restAt) {
        const restMs = this.pickInt(s().rest.minutes) * 60_000;
        await this.wait('rest', restMs, signal);
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

      if (this.applyKillSwitch()) return;
      const decision = this.governor!.allow({ kind: 'search' });
      if (!decision.allowed) {
        if (decision.reason === 'kill_switch') return this.stop('kill_switch', decision.detail);
        if (decision.detail?.startsWith('session_length')) return this.stop('session_length');
        const snapshot = this.governor!.snapshot();
        this.addLog({ kind: 'blocked', message: `Search paused by safety limits (${decision.detail ?? decision.reason})` });
        await this.wait('blocked', Math.max(snapshot.cooldownRemainingMs, MIN_BLOCKED_WAIT_MS), signal);
        continue;
      }

      this.setState({ phase: 'searching', phaseEndsAt: null, stopReason: null, stopDetail: null });
      const cap = this.priceCap(target.filter);
      const collected = new Map<string, TrimmedAuction>();
      const off = this.deps.adapter.onAuctions((raw) => {
        for (const a of raw as TrimmedAuction[]) collected.set(a.tradeId, a);
      });
      const searchFilter: FilterCriteria = cap == null ? target.filter : { ...target.filter, maxPrice: cap };
      const outcome = await this.deps.adapter.search(searchFilter);
      off();
      if (signal.aborted) return;

      this.stats.searches++;
      searchesSinceBreak++;
      if (!outcome.ok) {
        failuresInRow++;
        this.addLog({ kind: 'failed', message: `Search "${target.name}" failed: ${outcome.error ?? 'unknown error'}` });
        if (failuresInRow >= MAX_SEARCH_FAILURES_IN_A_ROW) return this.stop('search_failing');
      } else {
        failuresInRow = 0;
        const matches = [...collected.values()]
          .filter((a) => this.matches(a, target.filter, cap))
          .sort((a, b) => a.buyNow - b.buyNow)
          .map((a) => ({ tradeId: a.tradeId, resourceId: a.resourceId, rating: a.rating, buyNow: a.buyNow, expiresAt: a.expiresAt }));
        this.addSearchResult(target.name, matches);
        if (matches.length > 0) {
          this.setState({ phase: 'buying', phaseEndsAt: null, stopReason: null, stopDetail: null });
          const stopped = await this.buyMatches(matches, signal);
          if (stopped) return;
        }
      }
      this.deps.onChange();

      await this.wait('waiting', this.pickSeconds(s().searchDelay) * 1000, signal);
    }
  }

  /** Returns true when the bot stopped while buying. */
  private async buyMatches(matches: SniperMatch[], signal: AbortSignal): Promise<boolean> {
    const t = this.settings.thresholds;
    for (const m of matches) {
      if (signal.aborted) return true;

      if (t.sessionCoinBudget > 0 && this.stats.coinsSpent + m.buyNow > t.sessionCoinBudget) {
        if (this.stats.coinsSpent >= t.sessionCoinBudget) {
          this.stop('coin_budget');
          return true;
        }
        continue; // a cheaper listing may still fit
      }

      const sellPrice = await this.deps.estimateSellPrice(m.resourceId);
      const profit = sellPrice == null ? null : Math.floor(sellPrice * (1 - EA_TAX)) - m.buyNow;
      // Unknown profit is allowed: the user capped the price, and the ledger
      // may simply not have seen this card sell yet.
      if (t.minProfit > 0 && profit != null && profit < t.minProfit) continue;

      if (this.applyKillSwitch()) return true;
      const decision = this.governor!.allow({ kind: 'buy', coins: m.buyNow });
      if (!decision.allowed) {
        this.deps.onAttempt?.({ ...this.attemptBase(m), outcome: 'blocked', latencyMs: null, errorCode: decision.reason ?? 'blocked' });
        this.addLog({ kind: 'blocked', resourceId: m.resourceId, rating: m.rating, price: m.buyNow, message: `Buy blocked by safety limits (${decision.detail ?? decision.reason})` });
        if (decision.reason === 'kill_switch') {
          this.stop('kill_switch', decision.detail);
          return true;
        }
        if (decision.reason === 'hard_stop') return false;
        continue;
      }

      const result = await this.deps.adapter.buy(m.tradeId, m.buyNow);
      if (signal.aborted && !result.ok) return true;
      if (result.ok) {
        this.stats.purchases++;
        this.stats.coinsSpent += m.buyNow;
        if (profit != null) this.stats.profit += profit;
        const entry = this.addLog({ kind: 'bought', resourceId: m.resourceId, rating: m.rating, price: m.buyNow, sellPrice, profit, message: 'bought' });
        this.recordTopSnipe(entry);
        this.deps.onAttempt?.({ ...this.attemptBase(m), outcome: 'success', latencyMs: result.latencyMs, errorCode: null });
        this.deps.onTrade?.({ tradeId: m.tradeId, resourceId: m.resourceId, buyPrice: m.buyNow });
        if (t.stopAfterPurchases > 0 && this.stats.purchases >= t.stopAfterPurchases) {
          this.stop('purchase_limit');
          return true;
        }
      } else {
        this.stats.failures++;
        this.addLog({ kind: 'failed', resourceId: m.resourceId, rating: m.rating, price: m.buyNow, message: result.error ?? 'buy failed' });
        this.deps.onAttempt?.({ ...this.attemptBase(m), outcome: 'failed', latencyMs: result.latencyMs, errorCode: result.error ?? 'unknown_error' });
      }
      this.deps.onChange();
    }
    return false;
  }

  // ---- helpers --------------------------------------------------------------

  private attemptBase(m: SniperMatch): Pick<AttemptInput, 'resourceId' | 'tradeId' | 'targetPrice' | 'listedPrice'> {
    return { resourceId: m.resourceId, tradeId: m.tradeId, targetPrice: m.buyNow, listedPrice: m.buyNow };
  }

  /** The lower of the filter's max price and the page's max buy price. */
  private priceCap(filter: FilterCriteria): number | null {
    const caps = [filter.maxPrice, this.settings.thresholds.maxBuyPrice || undefined].filter((n): n is number => n != null && n > 0);
    return caps.length > 0 ? Math.min(...caps) : null;
  }

  /** Guards against listings that reached the page from somewhere other than
   * this search (the user searching by hand while the bot runs). */
  private matches(a: TrimmedAuction, f: FilterCriteria, cap: number | null): boolean {
    if (a.buyNow <= 0) return false;
    if (cap != null && a.buyNow > cap) return false;
    if (f.resourceId != null && a.resourceId !== f.resourceId) return false;
    if (f.minRating != null && a.rating < f.minRating) return false;
    if (f.maxRating != null && a.rating > f.maxRating) return false;
    if (a.expiresAt != null && a.expiresAt <= this.now()) return false;
    return true;
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

  private addSearchResult(filterName: string, matches: SniperMatch[]): void {
    const result: SniperSearchResult = { id: this.nextId++, at: this.now(), filterName, matches };
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
  search_failing: 'searches keep failing',
};
