/*
 * gallery.ts — Nova AI's Gallery mode: the trader's list of cards for FC's
 * Gallery Sets (@sl/shared `GalleryState`), and the rules engine/sniper.ts
 * (`runGallery`) works it through with.
 *
 * EA's web app has no Gallery, so Nova cannot read a Set or its grade: the
 * trader pastes the cards a Set needs, and Nova buys each one, sends it to
 * the club and lists it again at once. EA's help says a card keeps counting
 * for its Sets after it is sold; whether it must reach the club first is not
 * known, and sending it there is the safe choice the trader made. One card
 * at a time:
 *   1. its version, when the rating is not the player's base card's: a
 *      look-only search of the player at that rating names it;
 *   2. its market price: FUTBIN's, else Nova's own market data, else the
 *      cheapest listing that search saw;
 *   3. for GALLERY_SNIPE_MS it buys only under the market price (one EA
 *      price step under it), then at the market price, a step higher after
 *      each search that found nothing, up to GALLERY_OVER_MARKET over it:
 *      past that the card is skipped, so a price spike never costs much;
 *   4. once bought: to the club, to the transfer list, and listed one step
 *      under the market price, the cheapest listing, so it sells first.
 * The list's coin budget caps what its buys spend, and every search and
 * buy goes through the same limits as the rest of Nova AI.
 */
import { GALLERY_LIMITS, MIN_SALE_PRICE, MIN_START_PRICE, stepPrice } from '@sl/shared';

import { fold, searchPlayers } from '../model/catalog.js';

import type { CatalogPlayer } from '../model/catalog.js';
import type { GalleryCard, GalleryState } from '@sl/shared';

/** How long Gallery mode looks for a card under the market price before it
 * pays the market price. */
export const GALLERY_SNIPE_MS = 120_000;
/** How far over the market price it goes for a card before it skips it. */
export const GALLERY_OVER_MARKET = 0.1;
/** Look-only searches for a card's version before it is skipped as not
 * listed. */
export const GALLERY_RESOLVE_TRIES = 2;

export interface ParsedGalleryList {
  cards: GalleryCard[];
  /** Lines that did not become a card, in the trader's words. */
  problems: string[];
}

/** A card's key on the list: the player and the rating. */
export function galleryKey(playerId: number, rating: number): string {
  return `${playerId}:${rating}`;
}

/** The player a typed name means: the one whose name is exactly that, or
 * the only one whose name holds it. Among namesakes, the one whose base
 * card is the highest rated at or under the typed rating (a special card
 * rates above its player's base card). */
function findPlayer(players: CatalogPlayer[], name: string, rating: number): CatalogPlayer[] {
  const wanted = fold(name.trim());
  const exact = players.filter((p) => fold(p.name) === wanted);
  const candidates = exact.length > 0 ? exact : searchPlayers(players, name, 12);
  if (candidates.length <= 1 || exact.length === 0) return candidates;
  const under = candidates.filter((p) => p.rating != null && p.rating <= rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return under.length > 0 ? [under[0]!] : [candidates[0]!];
}

/**
 * The pasted list as cards. One card a line, the name and the rating in
 * either order ("Hugo Ekitiké 85", "85 Hugo Ekitiké"); a line starting with
 * "#" or ending with ":" names the Set the cards under it belong to; blank
 * lines and lines starting with "//" are left out. Each name is looked up in
 * EA's player list (`players`, the web app's own). A card already on the
 * list (`keep`, same player and rating) keeps its progress, so pasting the
 * list again never buys a finished card twice.
 */
export function parseGalleryList(text: string, players: CatalogPlayer[], keep: GalleryCard[] = []): ParsedGalleryList {
  const kept = new Map(keep.map((c) => [c.key, c]));
  const cards: GalleryCard[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let set: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/\s+/g, ' ');
    if (line === '' || line.startsWith('//')) continue;
    const where = `Line ${i + 1}`;
    if (line.startsWith('#') || line.endsWith(':')) {
      const heading = line.replace(/^#+/, '').replace(/:$/, '').trim();
      set = heading === '' ? undefined : heading.slice(0, GALLERY_LIMITS.setLength);
      continue;
    }
    const m = /^(\d{2})\s+(.+)$/.exec(line) ?? /^(.+?)\s+(\d{2})$/.exec(line);
    const rating = m ? Number(/^\d+$/.test(m[1]!) ? m[1] : m[2]) : NaN;
    const name = m ? (/^\d+$/.test(m[1]!) ? m[2]! : m[1]!).trim() : '';
    if (!m || !Number.isInteger(rating) || rating < GALLERY_LIMITS.rating.min || rating > GALLERY_LIMITS.rating.max) {
      problems.push(`${where}: "${line}" needs a player name and a rating (for example "Hugo Ekitiké 85")`);
      continue;
    }
    if (players.length === 0) {
      problems.push(`${where}: EA's player list is not loaded yet — open the transfer market search once, then load the list again`);
      continue;
    }
    const found = findPlayer(players, name, rating);
    if (found.length === 0) {
      problems.push(`${where}: no player named "${name}" in EA's player list`);
      continue;
    }
    if (found.length > 1) {
      const some = found.slice(0, 3).map((p) => p.name).join(', ');
      problems.push(`${where}: "${name}" matches more than one player (${some}…) — write the full name`);
      continue;
    }
    const player = found[0]!;
    const key = galleryKey(player.id, rating);
    if (seen.has(key)) {
      problems.push(`${where}: ${player.name} ${rating} is on the list already`);
      continue;
    }
    if (cards.length >= GALLERY_LIMITS.cards) {
      problems.push(`${where}: the list holds at most ${GALLERY_LIMITS.cards} cards`);
      break;
    }
    seen.add(key);
    const before = kept.get(key);
    const card: GalleryCard = before
      ? { ...before, set }
      : {
          key,
          name: player.name.slice(0, GALLERY_LIMITS.nameLength),
          rating,
          playerId: player.id,
          status: 'todo',
          set,
          // A player's base card has the player's own id.
          ...(player.rating === rating ? { resourceId: player.id } : {}),
        };
    if (card.set === undefined) delete card.set;
    cards.push(card);
  }
  return { cards, problems };
}

/** The next card to buy, or null once every card is done. */
export function nextGalleryCard(state: GalleryState): GalleryCard | null {
  return state.cards.find((c) => c.status === 'todo') ?? null;
}

/** How many cards are at each step. */
export function gallerySummary(state: GalleryState): Record<GalleryCard['status'], number> & { total: number } {
  const counts = { todo: 0, bought: 0, club: 0, listed: 0, skipped: 0, total: state.cards.length };
  for (const c of state.cards) counts[c.status]++;
  return counts;
}

/** The most it pays for a card in its first minutes: one EA price step
 * under the market price. */
export function gallerySnipeCap(market: number): number {
  return stepPrice(market, -1);
}

/** The most it pays once those minutes are over: the market price, then one
 * step more for each search since that found nothing (`steps`). Null past
 * GALLERY_OVER_MARKET over the market price: the card is skipped. */
export function galleryMarketCap(market: number, steps: number): number | null {
  const cap = stepPrice(market, steps);
  return cap > market * (1 + GALLERY_OVER_MARKET) ? null : cap;
}

/** The prices a bought card is listed at: one step under the market price
 * (the cheapest listing, so it sells first), and a starting bid a step
 * under that. */
export function galleryListPrices(market: number): { startPrice: number; buyNowPrice: number } {
  const buyNowPrice = Math.max(MIN_SALE_PRICE, stepPrice(market, -1));
  return { buyNowPrice, startPrice: Math.max(MIN_START_PRICE, stepPrice(buyNowPrice, -1)) };
}

/** A card's version from a look-only search's matches: the player's base
 * card when it is listed, else the version listed most. Null: none listed. */
export function pickResourceId(matches: readonly { resourceId: number }[], playerId: number): number | null {
  if (matches.length === 0) return null;
  if (matches.some((m) => m.resourceId === playerId)) return playerId;
  const counts = new Map<number, number>();
  for (const m of matches) counts.set(m.resourceId, (counts.get(m.resourceId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}
