/*
 * trade-lifecycle.ts — following a bought card to its sale (defect C13).
 *
 * The extension used to record buys only: a card went on the ledger as
 * `bought` and stayed there, so session P&L was just what was spent. This
 * keeps one record per card, keyed by EA's `itemId` — the listing's
 * `tradeId` changes every time the card is listed or relisted, the item's
 * id does not — and walks it through what the trader's own trade pile
 * shows (main/adapter.ts reads it passively):
 *
 *   bought -> listed(price) -> sold(price, soldAt)
 *                          \-> expired -> listed again (a relist) -> ...
 *   listed/expired -> gone (missing from a full trade pile: sold unseen,
 *                          quick-sold, or moved to the club)
 *
 * Only a card it saw listed can have a sale: a `closed` item counts only
 * once the card was seen listed at least once, and never on the tradeId
 * the card was bought on (any other tradeId of the card is one of its own
 * listings, seen or not). The bought auction itself shows as
 * `closed` at the price paid (watch list, trade status), and reading that
 * as a sale would report the purchase as a zero-profit sale.
 *
 * A sale is reported through the same path as the buy (`/trades/batch`,
 * via telemetry) with the buy's own `tradeId`, `status: 'sold'`,
 * `sellPrice` and `soldAt`: the server then updates the bought trade and
 * computes tax and net profit itself. Nothing here sends a profit figure.
 *
 * Reported once: the record is persisted as sold before the report goes
 * out and marked reported after, so a duplicate trade-pile response (or two
 * tabs, or a reload) never reports it twice, and a report that failed is
 * re-sent by `resumeUnreported`. Every operation runs one at a time, so
 * two responses arriving together cannot both see the card unsold.
 *
 * No chrome APIs: the store is an interface (background gives it an
 * IndexedDB one, store/lifecycle-db.ts), so the userscript build can reuse
 * this module as-is.
 */
import { computeTradeProfit, EA_TAX_RATE, MAX_COIN_PRICE, type LifecycleBuy, type LifecycleSessionPnl, type LifecycleStats, type Trade, type TradePileItem } from '@sl/shared';

export type LifecycleState = 'bought' | 'listed' | 'expired' | 'sold' | 'gone';

export interface LifecycleRecord {
  itemId: string;
  /** The tradeId the buy was reported with: every later report of this
   * card uses it, so the server updates that trade rather than adding one. */
  buyTradeId: string;
  resourceId: number;
  rating: number | null;
  buyPrice: number;
  boughtAt: string;
  state: LifecycleState;
  /** The current (or last) listing of the card, and its buy-now price. */
  listTradeId: string | null;
  listPrice: number | null;
  relists: number;
  sellPrice: number | null;
  soldAt: string | null;
  /** The sale has been handed to `reportSale`. */
  saleReported: boolean;
  updatedAt: number;
}

export interface LifecycleStore {
  get(itemId: string): Promise<LifecycleRecord | undefined>;
  put(record: LifecycleRecord): Promise<void>;
  delete(itemId: string): Promise<void>;
  all(): Promise<LifecycleRecord[]>;
}

export interface LifecycleDeps {
  store: LifecycleStore;
  /** Queue the sale for `/trades/batch`, durably. Throws when it was not
   * queued: the sale stays unreported and `resumeUnreported` sends it
   * again. */
  reportSale: (trade: Trade) => void | Promise<void>;
  /** Where `buysWithoutItemId` is kept, so it survives a restart (an MV3
   * service worker stops whenever it is idle). In memory without one. */
  counter?: { get(): Promise<number>; set(value: number): Promise<void> };
  now?: () => number;
}

/** Reported sales and gone items are kept this long, then pruned. */
export const LIFECYCLE_RETENTION_MS = 30 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;

/** The `reportSale` background gives the lifecycle: queue the sale for
 * `/trades/batch` and wait until the queue is persisted before it counts
 * as reported. Nothing queued (no account yet, say) throws, so the sale
 * stays unreported and is retried; the one exception is a user who opted
 * out of telemetry, whose sale must never be sent at all. */
export function queueSale(deps: {
  enqueue: (trade: Trade) => Promise<{ queued: number }>;
  persisted: () => Promise<void>;
  optedOut: () => Promise<boolean>;
}): (trade: Trade) => Promise<void> {
  return async (trade) => {
    const { queued } = await deps.enqueue(trade);
    if (queued === 0) {
      if (await deps.optedOut()) return;
      throw new Error('sale not queued');
    }
    await deps.persisted();
  };
}

/** A store in memory: tests, and a fallback where IndexedDB is missing. */
export function createMemoryLifecycleStore(): LifecycleStore {
  const rows = new Map<string, LifecycleRecord>();
  return {
    get: async (itemId) => {
      const row = rows.get(itemId);
      return row ? { ...row } : undefined;
    },
    put: async (record) => {
      rows.set(record.itemId, { ...record });
    },
    delete: async (itemId) => {
      rows.delete(itemId);
    },
    all: async () => Array.from(rows.values(), (r) => ({ ...r })),
  };
}

function inCoinRange(price: number): boolean {
  return Number.isInteger(price) && price > 0 && price <= MAX_COIN_PRICE;
}

/** What a sold listing sold for. EA's `currentBid` on a `closed` listing
 * is the winning price (a buy-now sets it to the buy-now price); if it is
 * missing, the buy-now price is the only price there was. An assumption
 * (docs/06-extension.md, day-one checklist). */
function salePrice(item: TradePileItem): number {
  return item.currentBid > 0 ? item.currentBid : item.buyNowPrice;
}

export class TradeLifecycle {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  /** Every record, loaded once and kept in step with the store (all writes
   * go through this instance). Bounded by pruning. */
  private cache: Map<string, LifecycleRecord> | null = null;
  private lastPruneAt = 0;
  private buysWithoutItemId: number | null = null;

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Run `fn` after every operation before it (and whatever it threw). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async records(): Promise<Map<string, LifecycleRecord>> {
    if (!this.cache) {
      const rows = await this.deps.store.all();
      this.cache = new Map(rows.map((r) => [r.itemId, r]));
    }
    if (this.now() - this.lastPruneAt >= PRUNE_EVERY_MS) await this.pruneNow();
    return this.cache;
  }

  private async put(record: LifecycleRecord): Promise<void> {
    await this.deps.store.put(record);
    this.cache?.set(record.itemId, record);
  }

  /** A card the engine bought. The first buy recorded for an item stands:
   * the same item cannot be bought twice without leaving the trader in
   * between, so a second report is a duplicate. A reported sale or a gone
   * item bought again starts a fresh record; a sale not yet reported is
   * never overwritten. A buy with no item id is only counted. */
  recordBuy(buy: LifecycleBuy): Promise<void> {
    return this.serial(async () => {
      const itemId = buy.itemId;
      if (!itemId) {
        const count = (await this.buysWithoutItemIdCount()) + 1;
        this.buysWithoutItemId = count;
        await this.deps.counter?.set(count).catch(() => undefined);
        return;
      }
      const existing = (await this.records()).get(itemId);
      if (existing && !(existing.state === 'gone' || (existing.state === 'sold' && existing.saleReported))) return;
      await this.put({
        itemId,
        buyTradeId: buy.tradeId,
        resourceId: buy.resourceId,
        rating: buy.rating,
        buyPrice: buy.buyPrice,
        boughtAt: buy.boughtAt,
        state: 'bought',
        listTradeId: null,
        listPrice: null,
        relists: 0,
        sellPrice: null,
        soldAt: null,
        saleReported: false,
        updatedAt: this.now(),
      });
    });
  }

  /** Trade-pile items the adapter read. Returns how many sales it
   * reported. Items with no recorded buy are ignored: without the buy
   * there is no trade on the server to close. With `full` (a plain GET of
   * the whole trade pile), a listed or expired item missing from it has
   * left the pile and becomes `gone`. */
  observePile(items: TradePileItem[], options: { full?: boolean } = {}): Promise<number> {
    return this.serial(async () => {
      const records = await this.records();
      let reported = 0;
      for (const item of items) {
        const record = records.get(item.itemId);
        if (!record || record.state === 'sold') continue;
        const next = this.advance(record, item);
        if (!next) continue;
        await this.put(next);
        if (next.state === 'sold' && (await this.report(next))) reported++;
      }
      if (options.full) {
        const present = new Set(items.map((i) => i.itemId));
        for (const record of Array.from(records.values())) {
          if ((record.state === 'listed' || record.state === 'expired') && !present.has(record.itemId)) {
            await this.put({ ...record, state: 'gone', updatedAt: this.now() });
          }
        }
      }
      return reported;
    });
  }

  /** Re-send every sale persisted as sold but never handed over (a report
   * that threw, or a reload between the two writes). */
  resumeUnreported(): Promise<number> {
    return this.serial(async () => {
      let sent = 0;
      for (const record of Array.from((await this.records()).values())) {
        if (record.state === 'sold' && !record.saleReported && (await this.report(record))) sent++;
      }
      return sent;
    });
  }

  /** Drop reported sales and gone items not touched for 30 days. */
  prune(): Promise<void> {
    return this.serial(async () => {
      await this.records();
      await this.pruneNow();
    });
  }

  private async pruneNow(): Promise<void> {
    this.lastPruneAt = this.now();
    const cutoff = this.now() - LIFECYCLE_RETENTION_MS;
    for (const record of Array.from(this.cache!.values())) {
      const finished = record.state === 'gone' || (record.state === 'sold' && record.saleReported);
      if (finished && record.updatedAt < cutoff) {
        await this.deps.store.delete(record.itemId);
        this.cache!.delete(record.itemId);
      }
    }
  }

  /** Realised profit from sales since `since` (net of EA's tax, the same
   * formula the server applies), and what the cards still listed are
   * listed at. Reads the in-memory records, never the whole store. */
  sessionPnl(since: number): Promise<LifecycleSessionPnl> {
    return this.serial(async () => {
      const pnl: LifecycleSessionPnl = { realised: 0, unrealised: 0, sales: 0, listed: 0, since };
      for (const r of (await this.records()).values()) {
        if (r.state === 'sold' && r.sellPrice != null && r.soldAt && Date.parse(r.soldAt) >= since) {
          pnl.realised += computeTradeProfit(r.buyPrice, r.sellPrice).netProfit;
          pnl.sales++;
        } else if (r.state === 'listed' && r.listPrice != null) {
          pnl.unrealised += r.listPrice;
          pnl.listed++;
        }
      }
      return pnl;
    });
  }

  private async buysWithoutItemIdCount(): Promise<number> {
    if (this.buysWithoutItemId === null) {
      const stored = this.deps.counter ? await this.deps.counter.get().catch(() => 0) : 0;
      this.buysWithoutItemId = Number.isInteger(stored) && stored >= 0 ? stored : 0;
    }
    return this.buysWithoutItemId;
  }

  /** Counters for the diagnostics report. */
  stats(): Promise<LifecycleStats> {
    return this.serial(async () => {
      const out: LifecycleStats = { buysWithoutItemId: await this.buysWithoutItemIdCount(), followed: 0, salesReported: 0 };
      for (const r of (await this.records()).values()) {
        if (r.state === 'bought' || r.state === 'listed' || r.state === 'expired') out.followed++;
        else if (r.state === 'sold' && r.saleReported) out.salesReported++;
      }
      return out;
    });
  }

  /** The record after `item`, or null when nothing changed. */
  private advance(record: LifecycleRecord, item: TradePileItem): LifecycleRecord | null {
    // The auction the card was bought on (EA shows it closed at the price
    // paid) says nothing about the card's own listings.
    if (item.tradeId === null || item.tradeId === record.buyTradeId) return null;
    const at = this.now();
    switch (item.tradeState) {
      case 'active': {
        if (!inCoinRange(item.buyNowPrice)) return null;
        if (record.state === 'listed' && record.listTradeId === item.tradeId && record.listPrice === item.buyNowPrice) return null;
        // A new listing after an earlier one is a relist.
        const relisted = record.listTradeId !== null && record.listTradeId !== item.tradeId;
        return { ...record, state: 'listed', listTradeId: item.tradeId, listPrice: item.buyNowPrice, relists: record.relists + (relisted ? 1 : 0), updatedAt: at };
      }
      case 'expired':
        if (record.state === 'expired' && record.listTradeId === item.tradeId) return null;
        return { ...record, state: 'expired', listTradeId: item.tradeId, updatedAt: at };
      case 'closed': {
        // Only a card seen listed at least once can have sold. An itemId is
        // one card, so any closed tradeId other than the one it was bought
        // on is that card's own listing, even one never seen active (a
        // "Relist all" whose response carries no auctions, sold before the
        // pile was next opened): a relist.
        if (record.state !== 'listed' && record.state !== 'expired' && record.state !== 'gone') return null;
        const price = salePrice(item);
        if (!inCoinRange(price)) return null;
        const relisted = record.listTradeId !== null && record.listTradeId !== item.tradeId;
        // Never before the purchase: the server rejects a sale that
        // precedes its buy, and the buy's time may come from a clock
        // slightly ahead of this one. Otherwise the time the sale was
        // seen, not when it happened (EA gives no sale time).
        const boughtAt = Date.parse(record.boughtAt);
        const soldAt = new Date(Number.isFinite(boughtAt) ? Math.max(at, boughtAt) : at).toISOString();
        return { ...record, state: 'sold', listTradeId: item.tradeId, relists: record.relists + (relisted ? 1 : 0), sellPrice: price, soldAt, saleReported: false, updatedAt: at };
      }
      default:
        // On the pile, not listed: nothing to record.
        return null;
    }
  }

  /** Hand one sale over, then remember that it was. */
  private async report(record: LifecycleRecord): Promise<boolean> {
    const trade: Trade = {
      id: crypto.randomUUID(),
      tradeId: record.buyTradeId,
      resourceId: record.resourceId,
      assetId: null,
      rating: record.rating,
      buyPrice: record.buyPrice,
      sellPrice: record.sellPrice,
      // The schema's tax *rate* field, a constant; the server ignores it
      // and computes the tax and net profit itself.
      eaTax: EA_TAX_RATE,
      netProfit: null,
      status: 'sold',
      boughtAt: record.boughtAt,
      soldAt: record.soldAt,
    };
    try {
      await this.deps.reportSale(trade);
    } catch {
      return false;
    }
    await this.put({ ...record, saleReported: true, updatedAt: this.now() });
    return true;
  }
}
