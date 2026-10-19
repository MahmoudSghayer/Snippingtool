/*
 * ea-listing.ts — one listing, whatever EA handed us. Every listing the
 * adapter records passes through `normaliseListing` first, then
 * `trimAuction` (main/adapter.ts, the privacy seam).
 *
 * The same auction arrives in different clothes depending on where the
 * adapter read it (docs/06-extension.md §4, all of it unverified until the
 * market opens):
 *   - a UTAS JSON `auctionInfo` entry (passive observation, and the promise
 *     shape's assumed envelope): auction fields at the top, card fields
 *     under `itemData`;
 *   - an item entity (the observable shape's `response.data.items`): card
 *     fields on the entity, auction fields behind `getAuctionData()` or on
 *     `_auction`;
 * and the card id may be called `resourceId`, `definitionId` or
 * `maskedDefId`. Never `assetId`: that is the base player, shared by every
 * version of a card, so pricing a listing by it would mix a special card's
 * listings in with the base card's. Each field is read defensively: an entry that does not
 * yield a tradeId, a positive card id and numeric prices is `null`, never a
 * half-filled listing with zeroes in it.
 */

import { ShapeError } from './ea-response.js';

import type { TradePileItem, WatchedAuction } from '@sl/shared';

/** `MAX_COIN_PRICE` from `@sl/shared`, restated: this file runs in the
 * MAIN world and imports nothing from the zod-carrying barrel (see
 * adapter.ts's header). Pinned equal by test/unit/ea-listing.test.ts. */
export const MAX_COIN_PRICE = 15_000_000;

/** EA's lowest starting bid (`MIN_START_PRICE` in @sl/shared), restated. */
const MIN_START_PRICE = 150;

/** EA's price grid (`priceStep` in @sl/shared's coins.ts), restated for the
 * same reason: the step between a price and the next one up. */
const PRICE_BANDS: readonly { below: number; step: number }[] = [
  { below: 1_000, step: 50 },
  { below: 10_000, step: 100 },
  { below: 50_000, step: 250 },
  { below: 100_000, step: 500 },
  { below: Infinity, step: 1_000 },
];

/** The lowest bid EA takes on an auction: its starting bid while nobody has
 * bid, else one step of EA's grid above the current bid (the current bid
 * rounded onto the grid first). Pinned to @sl/shared's `stepPrice(bid, 1)`
 * by test/unit/ea-listing.test.ts; content computes the same with that
 * (engine/bidder.ts), and the adapter refuses any other amount. */
export function nextBidPrice(startingBid: number, currentBid: number): number {
  if (!(currentBid > 0)) return startingBid;
  const clamp = (p: number) => Math.min(MAX_COIN_PRICE, Math.max(MIN_START_PRICE, p));
  const p = clamp(currentBid);
  const onGrid = clamp(Math.round(p / stepAbove(p)) * stepAbove(p));
  return clamp(onGrid + stepAbove(onGrid));
}

/** The step between `price` and the next price up on EA's grid. */
function stepAbove(price: number): number {
  for (let i = 0; i < PRICE_BANDS.length; i++) if (price < PRICE_BANDS[i]!.below) return PRICE_BANDS[i]!.step;
  return 1_000;
}

const toNumber = Number;
const toStr = String;
const isFiniteNumber = Number.isFinite;
const isInteger = Number.isInteger;

export interface NormalisedListing {
  tradeId: string;
  resourceId: number;
  assetId: number;
  rating: number;
  buyNowPrice: number;
  startingBid: number;
  currentBid: number;
  offers: number;
  /** Seconds remaining when the listing was read, or null if unknown. */
  expires: number | null;
  tradeState?: string;
  name?: string;
  /** EA's id for the card itself (UTAS `itemData.id`, an entity's `id`):
   * unlike the tradeId it survives a purchase and every relist. */
  itemId?: string;
}

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | null {
  return value !== null && typeof value === 'object' ? (value as Obj) : null;
}

/** The auction half: `getAuctionData()` (a method of EA's own entity — the
 * same call its UI makes to render a row), then `_auction`, then the entry
 * itself (UTAS JSON). A throwing accessor means an unreadable entry. */
function auctionPart(entry: Obj): Obj | null {
  const accessor = entry.getAuctionData;
  if (typeof accessor === 'function') {
    try {
      return asObject(Reflect.apply(accessor, entry, []));
    } catch {
      return null;
    }
  }
  return asObject(entry._auction) ?? entry;
}

/** A number, or `fallback` when the field is absent; NaN when present but
 * not numeric (so the caller can reject it). */
function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  return toNumber(value);
}

function firstPresent(...values: unknown[]): unknown {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}

export function normaliseListing(entry: unknown): NormalisedListing | null {
  const e = asObject(entry);
  if (!e) return null;
  const auction = auctionPart(e);
  if (!auction) return null;
  // UTAS JSON keeps the card under `itemData`; an entity is the card.
  const item = asObject(e.itemData) ?? e;

  const tradeIdRaw = auction.tradeId;
  if ((typeof tradeIdRaw !== 'number' && typeof tradeIdRaw !== 'string') || toStr(tradeIdRaw) === '') return null;

  const resourceId = num(firstPresent(item.resourceId, item.definitionId, item.maskedDefId), 0);
  const listing: NormalisedListing = {
    tradeId: toStr(tradeIdRaw),
    resourceId,
    // UTAS JSON calls the base player `assetId`; the web app's own item
    // entity calls it `databaseId` (docs/06-extension.md, "checked against
    // the FC 27 web app"). Read as 0 there, the act result and the network
    // response for the same listing disagreed on it.
    assetId: num(firstPresent(item.assetId, item.databaseId), 0),
    rating: num(item.rating, 0),
    buyNowPrice: num(auction.buyNowPrice, 0),
    startingBid: num(auction.startingBid, 0),
    currentBid: num(auction.currentBid, 0),
    offers: num(auction.offers, 0),
    expires: null,
  };
  if (!(resourceId > 0)) return null;
  for (const field of ['assetId', 'rating', 'buyNowPrice', 'startingBid', 'currentBid', 'offers'] as const) {
    if (!isFiniteNumber(listing[field])) return null;
  }
  const expires = num(auction.expires, NaN);
  listing.expires = isFiniteNumber(expires) ? expires : null;
  if (typeof auction.tradeState === 'string') listing.tradeState = auction.tradeState;
  if (typeof item.name === 'string') listing.name = item.name;
  const itemId = readItemId(item);
  if (itemId) listing.itemId = itemId;
  return listing;
}

const ITEM_ID = /^[1-9][0-9]{0,19}$/;

/** The item's own id, as a string, or null. UTAS keeps it as
 * `itemData.id`; an entity carries it as `id` (both assumptions,
 * docs/06-extension.md). */
function readItemId(item: Obj): string | null {
  const raw = item.id;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const id = toStr(raw);
  return ITEM_ID.test(id) ? id : null;
}

/** Every readable listing in a page of results. An empty page is an empty
 * list; a non-empty page none of which can be read is a shape change, and
 * throws — reporting "no results" there would be a silent success. On a
 * mixed page, `onSkipped` hears how many entries were unreadable, so a
 * partial shape change is visible rather than just thinner results. */
export function normaliseListings(entries: unknown[], onSkipped?: (count: number) => void): NormalisedListing[] {
  const out: NormalisedListing[] = [];
  for (let i = 0; i < entries.length; i++) {
    const listing = normaliseListing(entries[i]);
    if (listing) out[out.length] = listing;
  }
  if (entries.length > 0 && out.length === 0) {
    throw new ShapeError(`none of the ${entries.length} search results could be read as a listing`);
  }
  if (out.length < entries.length) onSkipped?.(entries.length - out.length);
  return out;
}

const PILE_STATES: ReadonlySet<string> = new Set(['active', 'closed', 'expired']);

/** One item on the trader's own trade pile (or watch list, relist or
 * trade-status response): the same UTAS entry / entity layouts as a
 * search listing, but keyed by the item, not the trade. An item that is
 * not listed has no trade (`tradeId` 0 or absent) and no `tradeState`. An
 * entry without an item id, a positive card id or numeric prices, or with
 * a `tradeState` other than active / closed / expired, is `null`: EA
 * changed something, and guessing at a sale is worse than missing one. */
export function normalisePileItem(entry: unknown): TradePileItem | null {
  const e = asObject(entry);
  if (!e) return null;
  const auction = auctionPart(e);
  if (!auction) return null;
  const item = asObject(e.itemData) ?? e;

  const itemId = readItemId(item);
  if (!itemId) return null;
  const resourceId = num(firstPresent(item.resourceId, item.definitionId, item.maskedDefId), 0);
  if (!(resourceId > 0) || !isInteger(resourceId)) return null;

  const tradeIdRaw = auction.tradeId;
  const tradeId = (typeof tradeIdRaw === 'number' || typeof tradeIdRaw === 'string') && toStr(tradeIdRaw) !== '' && toStr(tradeIdRaw) !== '0' ? toStr(tradeIdRaw) : null;

  const stateRaw = auction.tradeState;
  let tradeState: TradePileItem['tradeState'] = null;
  if (typeof stateRaw === 'string') {
    if (!PILE_STATES.has(stateRaw)) return null;
    tradeState = stateRaw as TradePileItem['tradeState'];
  } else if (stateRaw !== undefined && stateRaw !== null) {
    return null;
  }

  const currentBid = num(auction.currentBid, 0);
  const buyNowPrice = num(auction.buyNowPrice, 0);
  const rating = num(item.rating, NaN);
  // Same bounds as the message schema (coinPriceSchema): one entry out of
  // range is skipped here rather than failing the whole message.
  for (const price of [currentBid, buyNowPrice]) {
    if (!isFiniteNumber(price) || price < 0 || price > MAX_COIN_PRICE || !isInteger(price)) return null;
  }
  const expires = num(auction.expires, NaN);
  return {
    itemId,
    tradeId: tradeId && tradeId.length <= 40 ? tradeId : null,
    resourceId,
    rating: isInteger(rating) && rating >= 0 && rating <= 99 ? rating : null,
    tradeState,
    currentBid,
    buyNowPrice,
    expires: isFiniteNumber(expires) ? expires : null,
  };
}

/** Every readable item in a trade-pile response, with the same rules as
 * `normaliseListings`: empty is empty, none readable throws, some
 * unreadable are counted through `onSkipped`. */
export function normalisePileItems(entries: unknown[], onSkipped?: (count: number) => void): TradePileItem[] {
  const out: TradePileItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const item = normalisePileItem(entries[i]);
    if (item) out[out.length] = item;
  }
  if (entries.length > 0 && out.length === 0) {
    throw new ShapeError(`none of the ${entries.length} trade-pile entries could be read as an item`);
  }
  if (out.length < entries.length) onSkipped?.(entries.length - out.length);
  return out;
}

const BID_STATES: ReadonlySet<string> = new Set(['highest', 'outbid', 'none', 'buyNow']);

/**
 * One auction on the trader's watch list (EA's Transfer Targets), for Nova
 * AI's Bid mode: the same UTAS entry / entity layouts as a search listing,
 * plus EA's `bidState` (`highest`, `outbid`, `none`, `buyNow`) beside the
 * `tradeState`. ASSUMED SHAPE — verify on day one (docs/06-extension.md,
 * day-one checklist): UTAS JSON watch list entries are said to carry
 * `bidState` beside `tradeState`; on an entity both are read from its
 * auction half (`getAuctionData()` or `_auction`), also under a leading
 * underscore. An entry without a tradeId, a positive card id or whole
 * prices within EA's limits, or with a state outside those lists, is
 * `null`: the bot then neither re-bids on it nor believes it won it.
 */
export function normaliseWatchedItem(entry: unknown): WatchedAuction | null {
  const e = asObject(entry);
  if (!e) return null;
  const auction = auctionPart(e);
  if (!auction) return null;
  const item = asObject(e.itemData) ?? e;

  const tradeIdRaw = auction.tradeId;
  if (typeof tradeIdRaw !== 'number' && typeof tradeIdRaw !== 'string') return null;
  const tradeId = toStr(tradeIdRaw);
  if (tradeId === '' || tradeId === '0' || tradeId.length > 40) return null;
  const resourceId = num(firstPresent(item.resourceId, item.definitionId, item.maskedDefId), 0);
  if (!(resourceId > 0) || !isInteger(resourceId)) return null;
  const assetId = num(firstPresent(item.assetId, item.databaseId), 0);
  if (!isInteger(assetId) || assetId < 0) return null;

  // null: the entry did not say; undefined: it said something unknown.
  const state = (value: unknown, allowed: ReadonlySet<string>): string | null | undefined => {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && allowed.has(value) ? value : undefined;
  };
  const bidState = state(firstPresent(auction.bidState, auction._bidState), BID_STATES);
  const tradeState = state(firstPresent(auction.tradeState, auction._tradeState), PILE_STATES);
  if (bidState === undefined || tradeState === undefined) return null;

  const currentBid = num(auction.currentBid, 0);
  const startingBid = num(auction.startingBid, 0);
  const buyNowPrice = num(auction.buyNowPrice, 0);
  for (const price of [currentBid, startingBid, buyNowPrice]) {
    if (!isFiniteNumber(price) || price < 0 || price > MAX_COIN_PRICE || !isInteger(price)) return null;
  }
  const rating = num(item.rating, NaN);
  const expires = num(auction.expires, NaN);
  return {
    tradeId,
    itemId: readItemId(item),
    resourceId,
    assetId,
    rating: isInteger(rating) && rating >= 0 && rating <= 99 ? rating : null,
    bidState: bidState as WatchedAuction['bidState'],
    tradeState: tradeState as WatchedAuction['tradeState'],
    currentBid,
    startingBid,
    buyNowPrice,
    expires: isFiniteNumber(expires) ? expires : null,
  };
}

/** Every readable auction on a watch list, with the same rules as
 * `normaliseListings`: empty is empty, none readable throws, some
 * unreadable are counted through `onSkipped`. */
export function normaliseWatchedItems(entries: unknown[], onSkipped?: (count: number) => void): WatchedAuction[] {
  const out: WatchedAuction[] = [];
  for (let i = 0; i < entries.length; i++) {
    const item = normaliseWatchedItem(entries[i]);
    if (item) out[out.length] = item;
  }
  if (entries.length > 0 && out.length === 0) {
    throw new ShapeError(`none of the ${entries.length} watch list entries could be read as an auction`);
  }
  if (out.length < entries.length) onSkipped?.(entries.length - out.length);
  return out;
}
