/*
 * assist.ts — M2: human-in-the-loop. Keyboard-driven filter cycling, a
 * human-triggered buy (the confirm keypress is the human's own decision —
 * this file never buys on its own), and session P&L accounting
 * (docs/01-architecture.md, milestone order). Every buy still goes through
 * `governor.allow()` first, same as autobuyer — a human pressing the
 * confirm key is not an exemption from the safety budget, it is the thing
 * the safety budget is shaped around.
 */
import type { Governor } from './governor.js';
import type { ScoredOpportunity } from './ranker.js';
import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';

export interface Keybindings {
  nextFilter: string;
  prevFilter: string;
  confirmBuy: string;
  togglePause: string;
}

export const DEFAULT_KEYBINDINGS: Keybindings = {
  nextFilter: 'ArrowRight',
  prevFilter: 'ArrowLeft',
  confirmBuy: 'Enter',
  togglePause: ' ',
};

export interface SessionPnl {
  coinsSpent: number;
  coinsEarned: number;
  netProfit: number;
  trades: number;
}

function emptyPnl(): SessionPnl {
  return { coinsSpent: 0, coinsEarned: 0, netProfit: 0, trades: 0 };
}

export interface FilterHandle {
  id: string;
}

export interface AssistDeps {
  governor: Governor;
  adapter: AdapterClient;
  /** Ordered list of active filters to cycle through — `content/index.ts`
   * keeps this in sync with `engine/ranker.ts`'s `rotateFilters()` output. */
  getFilters: () => FilterHandle[];
  /** Current ranked candidates for whichever filter is active — refreshed
   * by `content/index.ts` after each search completes. */
  getRanked: () => ScoredOpportunity[];
  /** Fired when the cycle keys select a new filter; the caller is
   * responsible for actually driving `adapter.search()` and reporting the
   * `search`/`filter_change` activity events (content/index.ts owns device/
   * session bookkeeping — see `engine/types.ts`). */
  onFilterSelected: (filter: FilterHandle) => void;
  onAttempt: (input: AttemptInput) => void;
  onTrade: (input: TradeInput) => void;
  keybindings?: Partial<Keybindings>;
}

export class AssistEngine {
  private index = 0;
  private paused = false;
  private pnl: SessionPnl = emptyPnl();
  private readonly keybindings: Keybindings;

  constructor(private readonly deps: AssistDeps) {
    this.keybindings = { ...DEFAULT_KEYBINDINGS, ...deps.keybindings };
  }

  get sessionPnl(): SessionPnl {
    return { ...this.pnl };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get activeFilter(): FilterHandle | null {
    return this.deps.getFilters()[this.index] ?? null;
  }

  setKeybindings(bindings: Partial<Keybindings>): void {
    Object.assign(this.keybindings, bindings);
  }

  /** Returns `true` if the key was one assist handles (so the caller's
   * `keydown` listener can `preventDefault()`), `false` otherwise. */
  handleKeydown(key: string): boolean {
    if (key === this.keybindings.togglePause) {
      this.paused = !this.paused;
      return true;
    }
    if (this.paused) return false;

    if (key === this.keybindings.nextFilter) {
      this.cycle(1);
      return true;
    }
    if (key === this.keybindings.prevFilter) {
      this.cycle(-1);
      return true;
    }
    if (key === this.keybindings.confirmBuy) {
      void this.confirmBuy();
      return true;
    }
    return false;
  }

  private cycle(direction: 1 | -1): void {
    const filters = this.deps.getFilters();
    if (filters.length === 0) return;
    this.index = (this.index + direction + filters.length) % filters.length;
    const filter = filters[this.index];
    if (filter) this.deps.onFilterSelected(filter);
  }

  /** The confirm keypress: buy the top-ranked candidate for the active
   * filter. A no-op if paused, if there is nothing ranked, or if the
   * governor denies it (denial is still reported as a `blocked` attempt —
   * that is what proves the governor did its job, docs/01-architecture.md
   * §3.4). */
  async confirmBuy(): Promise<void> {
    if (this.paused) return;
    const top = this.deps.getRanked()[0];
    if (!top) return;

    const decision = this.deps.governor.allow({ kind: 'buy', coins: top.price });
    if (!decision.allowed) {
      this.deps.onAttempt({
        resourceId: top.resourceId,
        tradeId: top.tradeId,
        targetPrice: top.price,
        listedPrice: top.price,
        outcome: 'blocked',
        latencyMs: null,
        errorCode: decision.reason ?? 'blocked',
      });
      return;
    }

    const result = await this.deps.adapter.buy(top.tradeId, top.price);
    if (result.ok) {
      this.deps.onAttempt({
        resourceId: top.resourceId,
        tradeId: top.tradeId,
        targetPrice: top.price,
        listedPrice: top.price,
        outcome: 'success',
        latencyMs: result.latencyMs,
        errorCode: null,
      });
      this.recordBuy(top.price);
      this.deps.onTrade({ tradeId: top.tradeId, resourceId: top.resourceId, buyPrice: top.price });
    } else {
      this.deps.onAttempt({
        resourceId: top.resourceId,
        tradeId: top.tradeId,
        targetPrice: top.price,
        listedPrice: top.price,
        outcome: 'failed',
        latencyMs: result.latencyMs,
        errorCode: result.error ?? 'unknown_error',
      });
    }
  }

  recordBuy(coins: number): void {
    this.pnl.coinsSpent += coins;
    this.pnl.trades += 1;
    this.pnl.netProfit = this.pnl.coinsEarned - this.pnl.coinsSpent;
  }

  /** Called by `content/index.ts` once a previously-bought trade is
   * reported sold (a later, separate signal — this engine does not itself
   * detect a sale, see `model/prices.ts`'s honest limits on sell detection). */
  recordSale(coins: number): void {
    this.pnl.coinsEarned += coins;
    this.pnl.netProfit = this.pnl.coinsEarned - this.pnl.coinsSpent;
  }

  resetSession(): void {
    this.pnl = emptyPnl();
  }
}
