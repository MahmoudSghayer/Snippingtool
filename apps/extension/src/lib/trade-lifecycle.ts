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
import { computeTradeProfit, EA_TAX_RATE, type LifecycleBuy, type LifecycleSessionPnl, type Trade, type TradePileItem } from '@sl/shared';

export type LifecycleState = 'bought' | 'listed' | 'expired' | 'sold';

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
  all(): Promise<LifecycleRecord[]>;
}

export interface LifecycleDeps {
  store: LifecycleStore;
  /** Queue the sale for `/trades/batch`. May throw: the sale stays
   * unreported and `resumeUnreported` sends it again. */
  reportSale: (trade: Trade) => void | Promise<void>;
  now?: () => number;
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
    all: async () => Array.from(rows.values(), (r) => ({ ...r })),
  };
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

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Run `fn` after every operation before it (and whatever it threw). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A card the engine bought. The first buy recorded for an item stands:
   * the same item cannot be bought twice without being sold in between,
   * so a second report is a duplicate. A sold item bought again starts a
   * fresh record. */
  recordBuy(buy: LifecycleBuy): Promise<void> {
    return this.serial(async () => {
      const existing = await this.deps.store.get(buy.itemId);
      if (existing && existing.state !== 'sold') return;
      await this.deps.store.put({
        itemId: buy.itemId,
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
   * there is no trade on the server to close. */
  observePile(items: TradePileItem[]): Promise<number> {
    return this.serial(async () => {
      let reported = 0;
      for (const item of items) {
        const record = await this.deps.store.get(item.itemId);
        if (!record || record.state === 'sold') continue;
        const next = this.advance(record, item);
        if (!next) continue;
        await this.deps.store.put(next);
        if (next.state === 'sold' && (await this.report(next))) reported++;
      }
      return reported;
    });
  }

  /** Re-send every sale persisted as sold but never handed over (a report
   * that threw, or a reload between the two writes). Run on start-up. */
  resumeUnreported(): Promise<number> {
    return this.serial(async () => {
      let sent = 0;
      for (const record of await this.deps.store.all()) {
        if (record.state === 'sold' && !record.saleReported && (await this.report(record))) sent++;
      }
      return sent;
    });
  }

  /** Realised profit from sales since `since` (net of EA's tax, the same
   * formula the server applies), and what the cards still listed are
   * listed at. */
  sessionPnl(since: number): Promise<LifecycleSessionPnl> {
    return this.serial(async () => {
      const pnl: LifecycleSessionPnl = { realised: 0, unrealised: 0, sales: 0, listed: 0, since };
      for (const r of await this.deps.store.all()) {
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

  /** The record after `item`, or null when nothing changed. */
  private advance(record: LifecycleRecord, item: TradePileItem): LifecycleRecord | null {
    const at = this.now();
    switch (item.tradeState) {
      case 'active': {
        if (record.state === 'listed' && record.listTradeId === item.tradeId && record.listPrice === item.buyNowPrice) return null;
        // A new listing after one expired is a relist.
        const relisted = record.state === 'expired' || (record.state === 'listed' && record.listTradeId !== null && record.listTradeId !== item.tradeId);
        return { ...record, state: 'listed', listTradeId: item.tradeId, listPrice: item.buyNowPrice, relists: record.relists + (relisted ? 1 : 0), updatedAt: at };
      }
      case 'expired':
        if (record.state === 'expired') return null;
        return { ...record, state: 'expired', listTradeId: item.tradeId ?? record.listTradeId, updatedAt: at };
      case 'closed': {
        const price = salePrice(item);
        if (!(price > 0)) return null;
        // Never before the purchase: the server rejects a sale that
        // precedes its buy, and the buy's time may come from a clock
        // slightly ahead of this one.
        const boughtAt = Date.parse(record.boughtAt);
        const soldAt = new Date(Number.isFinite(boughtAt) ? Math.max(at, boughtAt) : at).toISOString();
        return { ...record, state: 'sold', listTradeId: item.tradeId ?? record.listTradeId, sellPrice: price, soldAt, saleReported: false, updatedAt: at };
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
    await this.deps.store.put({ ...record, saleReported: true, updatedAt: this.now() });
    return true;
  }
}
