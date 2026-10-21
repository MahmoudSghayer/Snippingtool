/*
 * gallery.ts — Nova AI's Gallery mode: the trader's list of cards for FC's
 * Gallery Sets (@sl/shared `GalleryState`), and the rules engine/sniper.ts
 * (`runGallery`) works it through with.
 *
 * EA's web app has no Gallery, so Nova cannot read a Set or its grade: the
 * trader pastes the cards a Set needs, and Nova buys each one, sends it to
 * the club and lists it again at once. EA's help ("How do Gallery Sets
 * work"): a card that passes through the club still counts for the Gallery
 * after it is sold, and one card can count for several Sets; the trader
 * then adds the cards to each Set in the game (Autocomplete, Confirm
 * Changes), which the web app cannot do. One card at a time:
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
 *
 * A fut.gg Set (`addFutggLineup`) puts fut.gg's cheapest lineup for the
 * Set's best grade on the list (its own Gallery solver, background/futgg.ts):
 * each card by its exact id (`exact`), so a holographic copy or another
 * version at the same rating, which scores differently, is never bought in
 * its place. Cards the club already holds are marked `owned` (EA's club
 * search, `markOwned`) and not bought.
 */
import { GALLERY_GRADES, GALLERY_LIMITS, MIN_SALE_PRICE, MIN_START_PRICE, stepPrice } from '@sl/shared';

import { fold, searchPlayers } from '../model/catalog.js';

import type { CatalogOption, CatalogPlayer } from '../model/catalog.js';
import type { FutggLineup, FutggSetSummary, FutggTier, GalleryCard, GallerySet, GalleryState } from '@sl/shared';

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

/** A card's key on the list: the player, the rating and (when one was
 * asked for) the version's rarity id, or (a fut.gg lineup card) its exact
 * card id. */
export function galleryKey(playerId: number, rating: number, rarity?: number, exactId?: number): string {
  const base = rarity === undefined ? `${playerId}:${rating}` : `${playerId}:${rating}:${rarity}`;
  return exactId === undefined ? base : `${base}#${exactId}`;
}

/** The rarity a typed version names in EA's Rarity list (the one the Search
 * tab's Rarity list shows): its name exactly (case and accents aside), else
 * the only one whose name holds it. */
function findRarity(rarities: CatalogOption[], version: string): CatalogOption[] {
  const wanted = fold(version.trim());
  const exact = rarities.filter((r) => fold(r.label) === wanted);
  return exact.length > 0 ? exact.slice(0, 1) : rarities.filter((r) => fold(r.label).includes(wanted));
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
 * either order ("Hugo Ekitiké 85", "85 Hugo Ekitiké"), and after the rating
 * the version when only one version will do ("Hugo Ekitiké 85 Signature":
 * two versions of a player can share a rating); a line starting with "#" or
 * ending with ":" names the Set the cards under it belong to; blank lines
 * and lines starting with "//" are left out. Each name is looked up in EA's
 * player list (`players`) and each version in its Rarity list (`rarities`),
 * both the web app's own. A card already on the list (`keep`, same player,
 * rating and version) keeps its progress, so pasting the list again never
 * buys a finished card twice.
 */
export function parseGalleryList(
  text: string,
  players: CatalogPlayer[],
  keep: GalleryCard[] = [],
  rarities: CatalogOption[] = [],
): ParsedGalleryList {
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
    // The rating first, or the name first with the version after the rating.
    const first = /^(\d{2})\s+(.+)$/.exec(line);
    const last = first ? null : /^(.+?)\s+(\d{2})(?:\s+(.+))?$/.exec(line);
    const rating = Number(first?.[1] ?? last?.[2] ?? NaN);
    const name = (first?.[2] ?? last?.[1] ?? '').trim();
    const versionText = last?.[3]?.trim();
    if ((!first && !last) || !Number.isInteger(rating) || rating < GALLERY_LIMITS.rating.min || rating > GALLERY_LIMITS.rating.max) {
      problems.push(`${where}: "${line}" needs a player name and a rating (for example "Hugo Ekitiké 85")`);
      continue;
    }
    let rarity: CatalogOption | undefined;
    if (versionText) {
      if (rarities.length === 0) {
        problems.push(`${where}: EA's Rarity list is not loaded yet — open the transfer market search once, then load the list again`);
        continue;
      }
      const versions = findRarity(rarities, versionText);
      if (versions.length !== 1) {
        problems.push(
          versions.length === 0
            ? `${where}: no version named "${versionText}" in EA's Rarity list — use a name from the Rarity list on the Search tab`
            : `${where}: "${versionText}" matches more than one version (${versions.slice(0, 3).map((r) => r.label).join(', ')}…) — write the full name`,
        );
        continue;
      }
      rarity = versions[0];
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
    const key = galleryKey(player.id, rating, rarity?.id);
    if (seen.has(key)) {
      problems.push(`${where}: ${player.name} ${rating}${rarity ? ` ${rarity.label}` : ''} is on the list already`);
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
          // A player's base card has the player's own id; a version asked for
          // is named by the first search.
          ...(player.rating === rating && !rarity ? { resourceId: player.id } : {}),
          ...(rarity ? { rarity: rarity.id, version: rarity.label.slice(0, GALLERY_LIMITS.versionLength) } : {}),
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
  const counts = { todo: 0, bought: 0, club: 0, listed: 0, skipped: 0, owned: 0, total: state.cards.length };
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

// ---- fut.gg Sets -------------------------------------------------------------

/** The grade Nova loads a fut.gg Set's lineup for: the best one fut.gg's
 * solver reaches (its last tier). Null: fut.gg has no lineup for the Set. */
export function futggBestTier(set: FutggSetSummary): FutggTier | null {
  const tiers = set.tiers.filter((t) => t.cards > 0);
  return tiers.length > 0 ? tiers[tiers.length - 1]! : null;
}

/** The Sets the picker offers, cheapest first: with `sOnly`, only those
 * whose best grade is S. A Set with nothing to buy is left out. */
export function futggSetChoices(sets: readonly FutggSetSummary[], sOnly: boolean): { set: FutggSetSummary; tier: FutggTier }[] {
  const out: { set: FutggSetSummary; tier: FutggTier }[] = [];
  for (const set of sets) {
    const tier = futggBestTier(set);
    if (!tier || (sOnly && tier.grade !== 'S')) continue;
    out.push({ set, tier });
  }
  return out.sort((a, b) => GALLERY_GRADES.indexOf(b.tier.grade) - GALLERY_GRADES.indexOf(a.tier.grade) || a.tier.cost - b.tier.cost || a.set.name.localeCompare(b.set.name));
}

export interface AddedLineup {
  state: GalleryState;
  /** Cards put on the list, and lineup cards it holds already (another
   * Set's: one card counts for several Sets). */
  added: number;
  already: number;
  problems: string[];
}

/**
 * fut.gg's lineup on the list, under its Set. Each card by its exact id
 * (`exact`), a special card's rarity searched for when EA's Rarity list has
 * it (a gold card's never: fut.gg gives them all rarity 0, whatever EA's own
 * list calls them), and fut.gg's price kept as the market price of last
 * resort (`guide`). A card the list holds already (another Set's, or this Set
 * loaded before) keeps its progress and counts for this Set too.
 */
export function addFutggLineup(state: GalleryState, lineup: FutggLineup, rarities: readonly CatalogOption[]): AddedLineup {
  const problems: string[] = [];
  const set = lineup.set;
  const tier = set.tiers.find((t) => t.grade === lineup.grade);
  const sets = (state.sets ?? []).filter((s) => s.id !== set.id);
  if (!tier) return { state, added: 0, already: 0, problems: [`${set.name}: fut.gg has no grade ${lineup.grade} lineup`] };
  if (sets.length >= GALLERY_LIMITS.sets) return { state, added: 0, already: 0, problems: [`The list holds at most ${GALLERY_LIMITS.sets} Sets`] };
  const entry: GallerySet = {
    id: set.id,
    name: set.name,
    path: set.path,
    grade: lineup.grade,
    threshold: tier.threshold,
    score: tier.score,
    tokens: tier.tokens,
    cost: tier.cost,
  };
  const rarityIds = new Set(rarities.map((r) => r.id));
  const cards = state.cards.map((c) => ({ ...c }));
  const byKey = new Map(cards.map((c) => [c.key, c]));
  let added = 0;
  let already = 0;
  for (const f of lineup.cards) {
    const key = galleryKey(f.playerId, f.rating, undefined, f.resourceId);
    const held = byKey.get(key);
    if (held) {
      already++;
      if (!(held.setIds ?? []).includes(set.id)) held.setIds = [...(held.setIds ?? []), set.id].slice(0, GALLERY_LIMITS.sets);
      continue;
    }
    if (cards.length >= GALLERY_LIMITS.cards) {
      problems.push(`${set.name}: the list holds at most ${GALLERY_LIMITS.cards} cards, so ${lineup.cards.length - added - already} of its cards were left out`);
      break;
    }
    // A special rarity (fut.gg gives every gold card 0, even a newer card of
    // the player with its own id), searched for and named; a holographic
    // copy named too. The exact id tells the rest apart.
    const special = f.rarity > 1;
    const version = (special ? `${f.version}${f.holographic ? ' Holographic' : ''}` : f.holographic ? 'Holographic' : '').trim();
    const card: GalleryCard = {
      key,
      name: f.name.slice(0, GALLERY_LIMITS.nameLength),
      rating: f.rating,
      playerId: f.playerId,
      resourceId: f.resourceId,
      exact: true,
      status: 'todo',
      set: set.name.slice(0, GALLERY_LIMITS.setLength),
      setIds: [set.id],
      score: f.score,
      // fut.gg prices a card it saw no listing for at 0: no price at all.
      ...(f.price >= MIN_SALE_PRICE ? { guide: f.price } : {}),
      ...(special && rarityIds.has(f.rarity) ? { rarity: f.rarity } : {}),
      ...(version ? { version: version.slice(0, GALLERY_LIMITS.versionLength) } : {}),
    };
    cards.push(card);
    byKey.set(key, card);
    added++;
  }
  if (lineup.missing > 0) {
    problems.push(
      `${set.name}: fut.gg does not describe ${lineup.missing} of its lineup ${lineup.missing === 1 ? 'card' : 'cards'}, so ${lineup.missing === 1 ? 'it was' : 'they were'} left out and the Set may miss grade ${lineup.grade}`,
    );
  }
  return { state: { ...state, cards, sets: [...sets, entry] }, added, already, problems };
}

/** The list without a fut.gg Set: its cards go unless another Set on the
 * list holds them too, or they are on their way (bought, in the club). */
export function removeFutggSet(state: GalleryState, setId: number): GalleryState {
  const cards: GalleryCard[] = [];
  for (const c of state.cards) {
    if (!c.setIds?.includes(setId)) {
      cards.push(c);
      continue;
    }
    const setIds = c.setIds.filter((id) => id !== setId);
    if (setIds.length > 0) cards.push({ ...c, setIds });
    else if (c.status === 'bought' || c.status === 'club') {
      const { setIds: _gone, ...rest } = c;
      cards.push(rest);
    }
  }
  const sets = (state.sets ?? []).filter((s) => s.id !== setId);
  const next: GalleryState = { ...state, cards };
  if (sets.length > 0) next.sets = sets;
  else delete next.sets;
  return next;
}

/** The exact cards whose club the trader should be asked about: fut.gg
 * lineup cards still to buy (or skipped), at most `max`. */
export function clubCheckIds(state: GalleryState, max = 100): number[] {
  const ids = new Set<number>();
  for (const c of state.cards) {
    if (!c.exact || c.resourceId === undefined || (c.status !== 'todo' && c.status !== 'skipped')) continue;
    ids.add(c.resourceId);
    if (ids.size >= max) break;
  }
  return [...ids];
}

/** Marks the cards the club holds as `owned` (they count for their Sets as
 * they are). One way only: a card the club no longer holds was collected
 * when it was there. Returns how many it marked. */
export function markOwned(state: GalleryState, owned: readonly number[]): number {
  const held = new Set(owned);
  let marked = 0;
  for (const c of state.cards) {
    if (!c.exact || c.resourceId === undefined || !held.has(c.resourceId) || (c.status !== 'todo' && c.status !== 'skipped')) continue;
    c.status = 'owned';
    delete c.note;
    marked++;
  }
  return marked;
}

export interface GallerySetProgress {
  set: GallerySet;
  /** Lineup cards on the list, and those collected (in the club, bought,
   * listed, or owned already). */
  cards: number;
  done: number;
  skipped: number;
  /** fut.gg's scores of the cards skipped: the Set's score falls by at
   * least that (bonus tags aside). */
  skippedScore: number;
}

/** Where each fut.gg Set on the list stands. */
export function gallerySetProgress(state: GalleryState): GallerySetProgress[] {
  return (state.sets ?? []).map((set) => {
    const mine = state.cards.filter((c) => c.setIds?.includes(set.id));
    const skipped = mine.filter((c) => c.status === 'skipped');
    return {
      set,
      cards: mine.length,
      done: mine.filter((c) => c.status === 'owned' || c.status === 'bought' || c.status === 'club' || c.status === 'listed').length,
      skipped: skipped.length,
      skippedScore: skipped.reduce((sum, c) => sum + (c.score ?? 0), 0),
    };
  });
}
