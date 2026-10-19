/*
 * shapes.ts — the candidate EA service-layer shapes, and the probe's choice
 * between them (docs/06-extension.md §4).
 *
 * Nothing about EA's service layer has been observed yet: the market is
 * locked until launch. So instead of one assumed shape, the adapter carries
 * every plausible one, each in its own small module, and the probe selects
 * whichever the page actually has:
 *
 *   - `observable` (main/shape-observable.ts): what community autobuyers
 *     describe — `services.Item.searchTransferMarket(criteria, page)` and
 *     `services.Item.bid(item, price)`, answering through
 *     `.observe(scope, (sender, response) => ...)`.
 *   - `promise` (main/shape-promise.ts): the shape the adapter was first
 *     written against — `services.Item.repository.search(criteria)` and
 *     `services.Transfer.repository.buyNow(tradeId)`, returning promises.
 *
 * Tried in that order (the observable shape has the better evidence). None
 * present means act is disabled, with a reason naming what each candidate
 * was missing. Each shape may also carry Nova AI's Bid mode calls
 * (`bidding`: a bid, a watch list read, a move to the transfer list),
 * checked on their own so a page without them still snipes. Adding a
 * third shape is a new module plus one line in
 * `SHAPES`; nothing outside `src/main/` knows shapes exist beyond the
 * probe's `shape` field.
 *
 * Zod-free and chrome-free, so the userscript build can bundle these with
 * the adapter.
 */
import { createObservableShape } from './shape-observable.js';
import { createPromiseShape } from './shape-promise.js';

import type { FilterCriteria } from '@sl/shared';

export type ShapeName = 'promise' | 'observable';

/** Longest the adapter waits on one EA service call before giving up with
 * an error. Under content's own 15 s act timeout (content/adapter-client.ts),
 * so the adapter's answer, not the timeout, is what content sees. */
export const SERVICE_CALL_TIMEOUT_MS = 12_000;

export interface BuyTarget {
  tradeId: string;
  /** The buy-now price already checked against the adapter's last-seen
   * listing (Task 2's price re-check). */
  price: number;
  /** The item entity an act search returned for this tradeId, for shapes
   * that buy on the entity rather than the tradeId. */
  entity: unknown;
  /** Called if EA answers after `buy` already rejected with
   * `TimeoutUnknownError`: `true` if that late answer says it bought. */
  onLate?: (bought: boolean) => void;
}

export interface ListTarget {
  /** The item entity this adapter bought (`actBuy`). */
  entity: unknown;
  startPrice: number;
  buyNowPrice: number;
  durationSeconds: number;
}

export interface BidTarget {
  tradeId: string;
  /** The bid, already checked against the auction as the adapter last saw
   * it (`bidCheck` in main/adapter.ts): exactly the next valid bid. */
  amount: number;
  /** The item entity a search or watch list read returned for this
   * tradeId, for shapes that bid on the entity. */
  entity: unknown;
}

/** Nova AI's Bid mode on a shape (automation builds). Separate from the
 * shape's own `detect`: a page without these functions still snipes, and
 * only Bid mode refuses to run (`watchlist_unsupported`). */
export interface BiddingShape {
  /** `null` when the page has every function Bid mode needs, otherwise the
   * first one it lacks. Reads properties only. */
  detect(services: unknown): string | null;
  /** Bid `target.amount` through the web app's own bid call. Resolves only
   * when EA's service says it was accepted. */
  bid(services: Record<string, unknown>, target: BidTarget): Promise<void>;
  /** The watch list through the web app's own service: the raw response
   * (for diagnostics) and its entries. Rejects on anything it cannot read,
   * never resolves with a list it did not see. */
  readWatchlist(services: Record<string, unknown>): Promise<{ response: unknown; entries: unknown[] }>;
  /** Move a won item (its entity) from the watch list to the transfer
   * list. Absent on a shape with no known call. */
  moveToTransferList?(services: Record<string, unknown>, entity: unknown): Promise<void>;
}

/** Search options that are not filter fields. */
export interface SearchOptions {
  /** Bid mode: auctions whose current bid is at most this (EA's `maxBid`). */
  maxBid?: number;
}

export interface ServiceShape {
  readonly name: ShapeName;
  /** `null` when this shape's functions are all present on `services`,
   * otherwise the first one that is not. Reads properties only; calls
   * nothing. */
  detect(services: unknown): string | null;
  /** Whether `buy` needs `BuyTarget.entity` — i.e. whether the adapter must
   * keep the entities its searches return. */
  readonly buysOnEntity: boolean;
  /** Run a search through EA's own service. Resolves with the raw response
   * (for diagnostics) and its list of entries; rejects on any response it
   * cannot read — never resolves with an empty list it did not see. */
  search(services: Record<string, unknown>, filter: FilterCriteria, options?: SearchOptions): Promise<{ response: unknown; entries: unknown[] }>;
  /** Buy at `target.price`. Resolves only when EA's service says it
   * worked; rejects otherwise. */
  buy(services: Record<string, unknown>, target: BuyTarget): Promise<void>;
  /** Whether `tradeId` is still an open listing. Rejects when unreadable. */
  readResult(services: Record<string, unknown>, tradeId: string): Promise<boolean>;
  /** List a bought item on the transfer market (auto-sell). Resolves only
   * when EA's service says it worked. Absent on a shape with no known
   * listing call. */
  list?(services: Record<string, unknown>, target: ListTarget): Promise<void>;
  /** Have the web app reload the transfer list through its own service.
   * Resolves when EA answered; the list itself reaches passive observation
   * like any trade-pile load. Absent on a shape with no known call. */
  refreshPile?(services: Record<string, unknown>): Promise<void>;
  /** The transfer list's entries (the web app's item entities), through its
   * own service: what a relist at new prices lists. Rejects on anything it
   * cannot read. Absent on a shape with no known call. */
  readPile?(services: Record<string, unknown>): Promise<unknown[]>;
  /** The web app's "Clear Sold": every sold card off the transfer list.
   * Resolves only when EA's service says it worked. */
  clearSold?(services: Record<string, unknown>): Promise<void>;
  /** The web app's "Re-list All": every unsold (expired) card back on the
   * market at its last prices. Resolves only when EA's service says so. */
  relistAll?(services: Record<string, unknown>): Promise<void>;
  /** Bid mode's calls. Absent on a shape with none known. */
  readonly bidding?: BiddingShape;
}

export const SHAPES: readonly ServiceShape[] = [createObservableShape(SERVICE_CALL_TIMEOUT_MS), createPromiseShape(SERVICE_CALL_TIMEOUT_MS)];

export interface ShapeCandidate {
  shape: ShapeName;
  present: boolean;
  reason?: string;
}

export interface ShapeSelection {
  shape: ServiceShape | null;
  /** Why no shape was selected (only when `shape` is null). */
  reason?: string;
  candidates: ShapeCandidate[];
}

/** Pick the first candidate shape `window.services` matches. */
export function selectShape(services: unknown): ShapeSelection {
  if (!services || typeof services !== 'object') {
    return {
      shape: null,
      reason: 'window.services is missing or not an object',
      candidates: SHAPES.map((s) => ({ shape: s.name, present: false, reason: 'window.services is missing' })),
    };
  }
  const candidates: ShapeCandidate[] = [];
  let selected: ServiceShape | null = null;
  for (const shape of SHAPES) {
    let missing: string | null;
    try {
      missing = shape.detect(services);
    } catch (err) {
      missing = `detection threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    candidates.push(missing === null ? { shape: shape.name, present: true } : { shape: shape.name, present: false, reason: missing });
    if (missing === null && !selected) selected = shape;
  }
  if (selected) return { shape: selected, candidates };
  const reasons = candidates.map((c) => `${c.shape}: ${c.reason}`).join('; ');
  return { shape: null, reason: `no known service-layer shape (${reasons})`, candidates };
}
