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
 *         \                \-> expired -> listed again (a relist) -> ...
 *          \-> sold (its listing never seen: see below)
 *   listed  -> sold, inferred (missing from a full trade pile: see below)
 *   expired -> gone (missing from a full trade pile: quick-sold, or moved
 *                    to the club)
 *
 * A listed card missing from a full trade pile sold. EA lets nobody remove
 * a card from the transfer list while its listing is live, so a card last
 * seen listed (not expired) that has left the pile was bought by someone:
 * the trader cleared it from the sold items (on the console or the phone
 * app), or every trade-pile read failed while it sold. Nova AI's auto-sell
 * lists at buy-now, so it is recorded sold at its list price, flagged
 * `saleSource: 'inferred'` (the server stores that, so reports can tell an
 * estimate from a sale seen). An expired card that left the pile may have
 * been quick-sold or sent to the club, so it stays `gone`, never reported;
 * `goneFrom` keeps which state it left from. A `gone` record from before
 * `goneFrom` existed cannot tell the two apart; the trader confirmed those
 * cards sold, so `resumeUnreported` reports each such record with a list
 * price once, as an inferred sale.
 *
 * Per browser, but not only this browser's buys: `seed` adds the account's
 * open trades (`GET /api/v1/extension/open-trades`, background/lifecycle.ts)
 * as `bought` records, so a card bought in one browser (the trader's PC)
 * and sold while the bot runs in another (a cloud machine) still has its
 * sale reported, on the original buy's tradeId. A record already here is
 * never overwritten by a seed. The server learns a card's item id from its
 * buy report; buys recorded here before buy reports carried it are re-sent
 * once with it (`reportItemIds`), so those cards can be followed too.
 *
 * A `closed` item is a sale on any tradeId but the one the card was bought
 * on: an itemId is one card, so any other tradeId of it is one of its own
 * listings, seen listed or not. The bought auction itself shows as
 * `closed` at the price paid (watch list, trade status), and reading that
 * as a sale would report the purchase as a zero-profit sale. A sale
 * straight from `bought` is the common case for Nova AI's own auto-sell:
 * it lists the card itself, and if no trade-pile load was read while the
 * listing was up (EA answering the reloads with errors, say), the first
 * the lifecycle sees of it is the sale. Those cards used to stay `bought`
 * for good.
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
import {
  computeTradeProfit,
  EA_TAX_RATE,
  MAX_COIN_PRICE,
  type LifecycleBuy,
  type LifecycleSessionPnl,
  type LifecycleStats,
  type OpenTrade,
  type Trade,
  type TradePileItem,
} from '@sl/shared';

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
  /** How the sale was known: seen sold on the trade pile, or inferred (a
   * listed card that left the pile, or an old `gone` record) at its list
   * price. Absent on records from before it existed: observed. */
  saleSource?: 'observed' | 'inferred';
  /** For a `gone` record: the state it left the trade pile from. Absent on
   * `gone` records from before it existed (see `resumeUnreported`). */
  goneFrom?: 'listed' | 'expired';
  /** Added by `seed` from the account's open trades (another browser's
   * buy), not by a buy in this browser. */
  seeded?: boolean;
  /** The server has (or has been sent) this buy with its item id: the buy
   * report carries it since item ids were stored, and `reportItemIds`
   * re-sends the buys recorded before that, once. */
  itemIdReported?: boolean;
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
  /** Queue the sale for `/trades/batch`, durably (also a buy re-sent with
   * its item id, `reportItemIds`). Throws when it was not queued: the sale
   * stays unreported and `resumeUnreported` sends it again. */
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

/** When a sale seen (or inferred) at `at` is recorded as made: never before
 * the purchase, since the server rejects a sale that precedes its buy and
 * the buy's time may come from a clock slightly ahead of this one.
 * Otherwise the time the sale was noticed, not when it happened (EA gives
 * no sale time). */
function soldAtFor(record: LifecycleRecord, at: number): string {
  const boughtAt = Date.parse(record.boughtAt);
  return new Date(Number.isFinite(boughtAt) ? Math.max(at, boughtAt) : at).toISOString();
}

/** A `gone` record from before `goneFrom` existed, with a price to report:
 * it left the pile listed or expired, which cannot be told apart now. */
function isLegacyGone(record: LifecycleRecord): boolean {
  return record.state === 'gone' && record.goneFrom === undefined && record.listPrice != null && inCoinRange(record.listPrice);
}

/** Done with: a reported sale, or a card that left the pile unsold. */
function isFinished(record: LifecycleRecord): boolean {
  return (record.state === 'sold' && record.saleReported) || (record.state === 'gone' && !isLegacyGone(record));
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
        // The buy report content sends alongside carries the item id.
        itemIdReported: true,
        updatedAt: this.now(),
      });
    });
  }

  /** Buys recorded here before buy reports carried the card's item id:
   * each card still followed (bought, listed or expired) is reported once
   * more as `bought`, now with its item id, so the server can list it in
   * the account's open trades and another browser can follow it (`seed`).
   * The server keeps a sale it already has, and every card field the
   * report leaves out. Returns how many it queued. */
  reportItemIds(): Promise<number> {
    return this.serial(async () => {
      let sent = 0;
      for (const record of Array.from((await this.records()).values())) {
        if (record.itemIdReported || record.seeded) continue;
        if (record.state !== 'bought' && record.state !== 'listed' && record.state !== 'expired') continue;
        const buy: Trade = {
          id: crypto.randomUUID(),
          tradeId: record.buyTradeId,
          itemId: record.itemId,
          resourceId: record.resourceId,
          assetId: null,
          rating: record.rating,
          buyPrice: record.buyPrice,
          sellPrice: null,
          eaTax: EA_TAX_RATE,
          netProfit: null,
          status: 'bought',
          boughtAt: record.boughtAt,
          soldAt: null,
        };
        try {
          await this.deps.reportSale(buy);
        } catch {
          continue; // not queued (signed out, say): tried again next time
        }
        await this.put({ ...record, itemIdReported: true });
        sent++;
      }
      return sent;
    });
  }

  /** Trade-pile items the adapter read. Returns how many sales it
   * reported. Items with no recorded buy are ignored: without the buy
   * there is no trade on the server to close. With `full` (a plain GET of
   * the whole trade pile), a followed item missing from it has left the
   * pile: a listed one sold (inferred, at its list price: see the header),
   * an expired one is `gone`. */
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
          if ((record.state !== 'listed' && record.state !== 'expired') || present.has(record.itemId)) continue;
          const at = this.now();
          if (record.state === 'listed' && record.listPrice != null && inCoinRange(record.listPrice)) {
            const sold: LifecycleRecord = { ...record, state: 'sold', sellPrice: record.listPrice, soldAt: soldAtFor(record, at), saleSource: 'inferred', saleReported: false, updatedAt: at };
            await this.put(sold);
            if (await this.report(sold)) reported++;
          } else {
            await this.put({ ...record, state: 'gone', goneFrom: record.state, updatedAt: at });
          }
        }
      }
      return reported;
    });
  }

  /** Re-send every sale persisted as sold but never handed over (a report
   * that threw, or a reload between the two writes). First, once per
   * record, a `gone` record from before `goneFrom` existed that has a list
   * price becomes an inferred sale at that price, dated when it went gone:
   * those cards sold (the trader confirmed it), and nothing else would ever
   * report them. Once sold, a record never goes back to `gone`, so each is
   * reported once. */
  resumeUnreported(): Promise<number> {
    return this.serial(async () => {
      let sent = 0;
      for (const found of Array.from((await this.records()).values())) {
        let record = found;
        if (isLegacyGone(record)) {
          record = { ...record, state: 'sold', sellPrice: record.listPrice, soldAt: soldAtFor(record, record.updatedAt), saleSource: 'inferred', saleReported: false, updatedAt: this.now() };
          await this.put(record);
        }
        if (record.state === 'sold' && !record.saleReported && (await this.report(record))) sent++;
      }
      return sent;
    });
  }

  /** The account's open trades (`GET /api/v1/extension/open-trades`): its
   * buys still `bought` on the server, whichever browser made them. Each
   * card not followed here starts as `bought`, on the buy's own tradeId,
   * so its sale is reported against that trade. A record already here is
   * kept as it is (it is as far along as this browser knows), unless it is
   * a finished record of an earlier purchase of the same card. With
   * `complete` (the server listed every open trade), a seeded record still
   * `bought` whose trade is no longer open (sold elsewhere, recorded on the
   * dashboard, or over the server's 30 days) is dropped. Returns how many
   * records it added. */
  seed(trades: OpenTrade[], options: { complete?: boolean } = {}): Promise<number> {
    return this.serial(async () => {
      const records = await this.records();
      let added = 0;
      for (const trade of trades) {
        const existing = records.get(trade.itemId);
        const rebought = existing !== undefined && existing.buyTradeId !== trade.tradeId && isFinished(existing) && Date.parse(trade.boughtAt) > Date.parse(existing.boughtAt);
        if (existing && !rebought) continue;
        await this.put({
          itemId: trade.itemId,
          buyTradeId: trade.tradeId,
          resourceId: trade.resourceId,
          rating: trade.rating,
          buyPrice: trade.buyPrice,
          boughtAt: trade.boughtAt,
          state: 'bought',
          listTradeId: null,
          listPrice: null,
          relists: 0,
          sellPrice: null,
          soldAt: null,
          saleReported: false,
          seeded: true,
          updatedAt: this.now(),
        });
        added++;
      }
      if (options.complete) {
        const open = new Set(trades.map((t) => t.tradeId));
        for (const record of Array.from(records.values())) {
          if (record.seeded && record.state === 'bought' && !open.has(record.buyTradeId)) {
            await this.deps.store.delete(record.itemId);
            records.delete(record.itemId);
          }
        }
      }
      return added;
    });
  }

  /** Drop reported sales and gone items not touched for 30 days, and seeded
   * cards bought over 30 days ago and never seen here (the server stops
   * listing them as open then too). */
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
      const finished = isFinished(record) && record.updatedAt < cutoff;
      const staleSeed = record.seeded === true && record.state === 'bought' && Date.parse(record.boughtAt) < cutoff;
      if (finished || staleSeed) {
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
        // An itemId is one card, so any closed tradeId other than the one it
        // was bought on (ruled out above) is that card's own listing, even
        // one never seen active: auto-sell's listing, sold before a
        // trade-pile load was read, or a "Relist all" whose response carries
        // no auctions.
        const price = salePrice(item);
        if (!inCoinRange(price)) return null;
        const relisted = record.listTradeId !== null && record.listTradeId !== item.tradeId;
        return {
          ...record,
          state: 'sold',
          listTradeId: item.tradeId,
          relists: record.relists + (relisted ? 1 : 0),
          sellPrice: price,
          soldAt: soldAtFor(record, at),
          saleSource: 'observed',
          saleReported: false,
          updatedAt: at,
        };
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
      itemId: record.itemId,
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
      // Left out for a sale seen (the server's default): an estimate says so.
      ...(record.saleSource === 'inferred' ? { saleSource: 'inferred' as const } : {}),
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
