/*
 * assist.ts — M2: human-in-the-loop. Keyboard-driven filter cycling, a
 * human-triggered buy (the confirm keypress is the human's own decision —
 * this file never buys on its own), and session P&L accounting
 * (docs/01-architecture.md, milestone order). Every buy still goes through
 * `governor.allow()` first, same as autobuyer — a human pressing the
 * confirm key is not an exemption from the safety budget, it is the thing
 * the safety budget is shaped around.
 *
 * The keys (P0 Task 13) are modifier chords (lib/hotkeys.ts): Alt+Up/Down
 * move a selection through the current search's listings, Alt+B shows a
 * confirm overlay for the selected one, and a second Alt+B (or a click on
 * the overlay) buys exactly that listing; Escape cancels. A key that is not
 * an assist chord is never reported as handled, so the caller never
 * `preventDefault`s EA's own keys (Enter, Space, the arrows).
 */
import { DEFAULT_ASSIST_HOTKEYS, type AssistHotkeys } from '@sl/shared';

import { ACT_ERROR, isAdapterRefusal } from '../lib/act-auth.js';
import { matchHotkey, type KeyChordEvent } from '../lib/hotkeys.js';

import type { Governor } from './governor.js';
import type { ScoredOpportunity } from './ranker.js';
import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';

/** How long the confirm overlay waits for the second press: a listing
 * shown longer ago than this may be gone, or no longer the one the user
 * means. */
export const CONFIRM_TIMEOUT_MS = 15_000;

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

/** The filters the filter chords cycle: the user's active ones
 * (`SavedFilter.isActive`, which the Sniping Bot page toggles), in order. */
export function activeFilterHandles(filters: readonly { id: string; isActive: boolean }[]): FilterHandle[] {
  return filters.filter((f) => f.isActive).map((f) => ({ id: f.id }));
}

export interface AssistDeps {
  governor: Governor;
  adapter: AdapterClient;
  /** Ordered list of the saved filters to cycle through: the active ones
   * (`SavedFilter.isActive`), in the user's order. */
  getFilters: () => FilterHandle[];
  /** The ranked listings of the *current* search only (content/index.ts
   * rebuilds them on every search): a listing from an earlier search is
   * never offered, selected or bought. */
  getRanked: () => ScoredOpportunity[];
  /** Fired when the cycle keys select a new filter; the caller is
   * responsible for actually driving `adapter.search()` and reporting the
   * `search`/`filter_change` activity events (content/index.ts owns device/
   * session bookkeeping — see `engine/types.ts`). */
  onFilterSelected: (filter: FilterHandle) => void;
  onAttempt: (input: AttemptInput) => void;
  onTrade: (input: TradeInput) => void;
  hotkeys?: AssistHotkeys;
  /** Whether this tab may act now: it holds the engine lease
   * (content/engine-lease.ts) and the plan still includes assist. Omitted =
   * always. */
  canAct?: () => boolean;
  /** The confirm overlay (ui/confirm-overlay.ts): shown for the listing the
   * buy chord picked, hidden once confirmed or cancelled. */
  confirm?: { show: (candidate: ScoredOpportunity) => void; hide: () => void };
  /** The selection moved (the panel highlights it). */
  onSelectionChange?: (tradeId: string | null) => void;
  now?: () => number;
}

export class AssistEngine {
  private index = 0;
  private paused = false;
  private pnl: SessionPnl = emptyPnl();
  private readonly hotkeys: AssistHotkeys;
  private selectedTradeId: string | null = null;
  private pending: { tradeId: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AssistDeps) {
    this.hotkeys = deps.hotkeys ?? DEFAULT_ASSIST_HOTKEYS;
    this.now = deps.now ?? Date.now;
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

  /** The listing the confirm overlay is waiting on, if any. */
  get pendingTradeId(): string | null {
    return this.pending?.tradeId ?? null;
  }

  private canAct(): boolean {
    return !this.deps.canAct || this.deps.canAct();
  }

  private buyable(): ScoredOpportunity[] {
    return this.deps.getRanked().filter((c) => c.buyable !== false);
  }

  /** The selected listing of the current search: the one the user moved to,
   * or the top-ranked one. */
  selected(): ScoredOpportunity | null {
    const ranked = this.buyable();
    return ranked.find((c) => c.tradeId === this.selectedTradeId) ?? ranked[0] ?? null;
  }

  /** Returns `true` if the key press was an assist chord it acted on (so
   * the caller's `keydown` listener can `preventDefault()` it), `false`
   * otherwise — always `false` for a key that is not an assist chord. */
  handleKeydown(e: KeyChordEvent): boolean {
    // Escape belongs to EA as much as to the overlay: cancel, never consume.
    if (e.key === 'Escape' || e.code === 'Escape') {
      this.cancelPending();
      return false;
    }
    const action = matchHotkey(e, this.hotkeys);
    if (!action) return false;
    if (action === 'togglePause') {
      this.paused = !this.paused;
      this.cancelPending();
      return true;
    }
    if (this.paused || !this.canAct()) return false;
    // A chord held down repeats: only a fresh press counts, so holding
    // Alt+B can never open and confirm a buy in one go.
    if (e.repeat) return true;

    switch (action) {
      case 'nextFilter':
        this.cycle(1);
        return true;
      case 'prevFilter':
        this.cycle(-1);
        return true;
      case 'selectUp':
        this.moveSelection(-1);
        return true;
      case 'selectDown':
        this.moveSelection(1);
        return true;
      case 'buy':
        if (this.pending) this.confirmPending();
        else this.requestBuy();
        return true;
    }
  }

  private cycle(direction: 1 | -1): void {
    const filters = this.deps.getFilters();
    if (filters.length === 0) return;
    this.index = (this.index + direction + filters.length) % filters.length;
    const filter = filters[this.index];
    if (filter) this.deps.onFilterSelected(filter);
  }

  private moveSelection(direction: 1 | -1): void {
    const ranked = this.buyable();
    if (ranked.length === 0) return;
    const at = Math.max(0, ranked.findIndex((c) => c.tradeId === this.selected()?.tradeId));
    const next = ranked[Math.min(ranked.length - 1, Math.max(0, at + direction))]!;
    this.selectedTradeId = next.tradeId;
    // A different listing is selected: the overlay no longer shows it.
    this.cancelPending();
    this.deps.onSelectionChange?.(next.tradeId);
  }

  /** The first buy chord: show the confirm overlay for the selected listing. */
  private requestBuy(): void {
    const target = this.selected();
    if (!target) return;
    this.pending = { tradeId: target.tradeId, at: this.now() };
    this.deps.confirm?.show(target);
  }

  /** The second buy chord, or the overlay's Confirm button: buy the listing
   * the overlay showed, if it is still in the current search and the
   * overlay has not waited too long. */
  confirmPending(): void {
    const pending = this.pending;
    this.cancelPending();
    if (!pending || this.now() - pending.at > CONFIRM_TIMEOUT_MS) return;
    void this.confirmBuy(pending.tradeId);
  }

  /** Escape, the overlay's Cancel button, or its timeout. */
  cancelPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.deps.confirm?.hide();
  }

  /** Buy `tradeId` (the confirmed listing), or with none the selected one.
   * A no-op if paused, if this tab may not act, if the listing is no longer
   * in the current search, or if the governor denies it (denial is still
   * reported as a `blocked` attempt — that is what proves the governor did
   * its job, docs/01-architecture.md §3.4). */
  async confirmBuy(tradeId?: string): Promise<void> {
    if (this.paused || !this.canAct()) return;
    // The ranker already drops listings the adapter cannot buy; skipping
    // them here too means none is ever attempted only to be refused.
    const top = tradeId == null ? this.selected() : (this.buyable().find((c) => c.tradeId === tradeId) ?? null);
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

    const result = await this.deps.adapter.buy(top.tradeId, top.price, { resourceId: top.resourceId });
    if (result.ok) {
      this.recordSuccess(top, result.latencyMs);
      return;
    }
    if (result.error === ACT_ERROR.timeoutUnknown) {
      // It reached EA and EA had not answered in time: it may have bought.
      // Recorded as attempted (outcome unknown), still charged to the
      // governor, and settled if EA's late answer arrives.
      this.deps.onAttempt({ ...this.attemptBase(top), outcome: 'attempted', latencyMs: result.latencyMs, errorCode: ACT_ERROR.timeoutUnknown });
      void result.late?.then((late) => {
        if (late.ok) this.recordSuccess(top, late.latencyMs);
      });
      return;
    }
    // A refusal never reached EA: give the governor its budget back — but
    // only when the adapter itself signed it. An unsigned outcome (a
    // timeout reported as adapter_unauthenticated on an unsigned probe's
    // hint) could be a page script's doing, and the buy may have happened.
    if (result.signed && isAdapterRefusal(result.error)) this.deps.governor.refund(decision);
    this.deps.onAttempt({ ...this.attemptBase(top), outcome: 'failed', latencyMs: result.latencyMs, errorCode: result.error ?? 'unknown_error' });
  }

  private attemptBase(top: ScoredOpportunity): { resourceId: number; tradeId: string; targetPrice: number; listedPrice: number } {
    return { resourceId: top.resourceId, tradeId: top.tradeId, targetPrice: top.price, listedPrice: top.price };
  }

  private recordSuccess(top: ScoredOpportunity, latencyMs: number): void {
    this.deps.onAttempt({ ...this.attemptBase(top), outcome: 'success', latencyMs, errorCode: null });
    this.recordBuy(top.price);
    this.deps.onTrade({ tradeId: top.tradeId, resourceId: top.resourceId, buyPrice: top.price });
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
