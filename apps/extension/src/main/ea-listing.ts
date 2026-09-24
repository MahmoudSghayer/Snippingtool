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
 * `maskedDefId`. Each field is read defensively: an entry that does not
 * yield a tradeId, a positive card id and numeric prices is `null`, never a
 * half-filled listing with zeroes in it.
 */

const toNumber = Number;
const toStr = String;
const isFiniteNumber = Number.isFinite;

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

  const resourceId = num(firstPresent(item.resourceId, item.definitionId, item.maskedDefId, item.assetId), 0);
  const listing: NormalisedListing = {
    tradeId: toStr(tradeIdRaw),
    resourceId,
    assetId: num(item.assetId, 0),
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
  return listing;
}

/** Every readable listing in a page of results. An empty page is an empty
 * list; a non-empty page none of which can be read is a shape change, and
 * throws — reporting "no results" there would be a silent success. */
export function normaliseListings(entries: unknown[]): NormalisedListing[] {
  const out: NormalisedListing[] = [];
  for (let i = 0; i < entries.length; i++) {
    const listing = normaliseListing(entries[i]);
    if (listing) out[out.length] = listing;
  }
  if (entries.length > 0 && out.length === 0) {
    throw new Error(`none of the ${entries.length} search results could be read as a listing`);
  }
  return out;
}
