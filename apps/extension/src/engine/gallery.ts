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
 *   2. its market price: FUTBIN's, else Nova's own market data, else
 *      fut.gg's, else the cheapest listing that search saw;
 *   3. for GALLERY_SNIPE_MS it buys only under the market price (one EA
 *      price step under it), then the cheapest listed: from the market
 *      price up, the search's max rising faster after each search that
 *      found none (`galleryMarketCap`), the cheapest match bought. A card
 *      is never skipped for its price: only the list's budget stops it
 *      (the page's max buy price plays no part), and a card nobody lists
 *      waits at the end of the list for another try;
 *   4. once bought: to the club, to the transfer list, and listed one step
 *      over what it cost, or higher when EA's tax would make that a loss
 *      (`galleryListPrices`).
 * The list's coin budget caps what its buys spend, and every search and
 * buy goes through the same limits as the rest of Nova AI.
 *
 * A fut.gg Set (`addFutggLineup`) puts fut.gg's cheapest lineup for the
 * Set's best grade on the list (its own Gallery solver, background/futgg.ts):
 * each card by its exact id (`exact`), so a holographic copy or another
 * version at the same rating, which scores differently, is never bought in
 * its place. Cards the club already holds are marked `owned` (EA's club
 * search, `markOwned`) and not bought, and a player the club holds that is
 * not in the lineup stands in for one that is when the Set still makes its
 * grade (`planFutggSwaps`, scored as fut.gg scores it: gallery-score.ts).
 * A Set whose cards are all collected is marked completed (`completed`,
 * and when in `completedAt`): never offered again, and its cards still to
 * buy are left alone.
 */
import { EA_TAX_RATE, GALLERY_GRADES, GALLERY_LIMITS, MIN_SALE_PRICE, MIN_START_PRICE, stepPrice } from '@sl/shared';

import { fold, searchPlayers } from '../model/catalog.js';

import { galleryScore } from './gallery-score.js';

import type { CatalogOption, CatalogPlayer } from '../model/catalog.js';
import type { FutggCard, FutggLineup, FutggSetSummary, FutggTier, GalleryCard, GalleryGrade, GallerySet, GallerySpare, GalleryState } from '@sl/shared';

/** How long Gallery mode looks for a card under the market price before it
 * buys the cheapest listed. */
export const GALLERY_SNIPE_MS = 30_000;
/** Look-only searches for a card's version before it is skipped as not
 * listed. */
export const GALLERY_RESOLVE_TRIES = 2;
/** How many passes a card may come back with no listing before it is left
 * out (`skipped`) rather than searched for again. A card nobody lists — an
 * SBC/Objective card not on the market, or a version that has gone extinct —
 * is then never searched endlessly, so empty searches can never pile up into
 * an EA rate limit. */
export const GALLERY_MISS_CAP = 3;

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

/** Whether a card is still wanted: not when every fut.gg Set it is on is
 * marked completed. */
export function galleryCardNeeded(card: GalleryCard, state: GalleryState): boolean {
  const done = state.completed;
  return !(done && done.length > 0 && card.setIds && card.setIds.length > 0 && card.setIds.every((id) => done.includes(id)));
}

/** The next card to buy, or null once every card is done. */
export function nextGalleryCard(state: GalleryState): GalleryCard | null {
  return state.cards.find((c) => c.status === 'todo' && galleryCardNeeded(c, state)) ?? null;
}

/** How many cards are at each step (`parked`: still to buy, but only for
 * Sets marked completed). */
export function gallerySummary(state: GalleryState): Record<GalleryCard['status'], number> & { total: number; parked: number } {
  const counts = { todo: 0, bought: 0, club: 0, listed: 0, skipped: 0, owned: 0, sbc: 0, parked: 0, total: state.cards.length };
  for (const c of state.cards) {
    if (c.status === 'todo' && !galleryCardNeeded(c, state)) counts.parked++;
    else counts[c.status]++;
  }
  return counts;
}

/** The most it pays for a card in the snipe window: one EA price step
 * under the market price. */
export function gallerySnipeCap(market: number): number {
  return stepPrice(market, -1);
}

/** The search's max once that window is over, the cheapest match bought:
 * the market price, then 1, 2, 4, 8… EA price steps over it after each
 * search that found none (`steps` such searches), so a card whose market
 * price was off is found in a few searches. No limit but the budget's. */
export function galleryMarketCap(market: number, steps: number): number {
  // 2^14 steps cover all of EA's price grid.
  return stepPrice(market, steps === 0 ? 0 : 2 ** Math.min(steps - 1, 14));
}

/** The prices a bought card is listed at: one EA price step over what it
 * cost, or, when EA's 5% tax on that would take more than the step adds
 * (over about 2,000 coins: 3,000 for a 2,900 card leaves 2,850), the
 * lowest price whose sale still brings back what it cost (3,100); and a
 * starting bid a step under that. `coversTax`: the second case. */
export function galleryListPrices(paid: number): { startPrice: number; buyNowPrice: number; coversTax: boolean } {
  const oneStep = Math.max(MIN_SALE_PRICE, stepPrice(paid, 1));
  let buyNowPrice = oneStep;
  while (Math.floor(buyNowPrice * (1 - EA_TAX_RATE)) < paid) {
    const next = stepPrice(buyNowPrice, 1);
    if (next === buyNowPrice) break; // EA's highest price
    buyNowPrice = next;
  }
  return { buyNowPrice, startPrice: Math.max(MIN_START_PRICE, stepPrice(buyNowPrice, -1)), coversTax: buyNowPrice > oneStep };
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

export interface FutggChoiceGroup {
  /** fut.gg's category ("Premier League / Barclays WSL"). */
  category: string;
  choices: { set: FutggSetSummary; tier: FutggTier }[];
}

/** The Sets the picker offers for a grade: those fut.gg has a lineup for at
 * that grade (with something to buy), by fut.gg's categories in fut.gg's
 * order, cheapest first in each. */
export function futggSetChoices(sets: readonly FutggSetSummary[], grade: GalleryGrade): FutggChoiceGroup[] {
  const groups = new Map<string, FutggChoiceGroup>();
  for (const set of sets) {
    const tier = set.tiers.find((t) => t.grade === grade && t.cards > 0);
    if (!tier) continue;
    const group = groups.get(set.category) ?? { category: set.category, choices: [] };
    group.choices.push({ set, tier });
    groups.set(set.category, group);
  }
  for (const g of groups.values()) g.choices.sort((a, b) => a.tier.cost - b.tier.cost || a.set.name.localeCompare(b.set.name));
  return [...groups.values()];
}

/** A Set's best grade: the highest grade fut.gg has a buyable lineup for
 * (tiers run D→best, so the last with cards). Null when fut.gg has none. */
export function bestFutggTier(set: FutggSetSummary): FutggTier | null {
  for (let i = set.tiers.length - 1; i >= 0; i--) {
    const tier = set.tiers[i]!;
    if (tier.cards > 0) return tier;
  }
  return null;
}

/** A Set's best grade that can be finished by buying alone: the highest grade
 * whose lineup is entirely on the transfer market (no SBC/Objective card, so
 * `sbc` is 0). Null when every grade needs a card off the market. A tier from
 * before the `sbc` field counts as fully buyable (`sbc` treated as 0). */
export function bestBuyableFutggTier(set: FutggSetSummary): FutggTier | null {
  for (let i = set.tiers.length - 1; i >= 0; i--) {
    const tier = set.tiers[i]!;
    if (tier.cards > 0 && (tier.sbc ?? 0) === 0) return tier;
  }
  return null;
}

/** For a Set whose best grade needs SBC/Objective cards (cards off the
 * transfer market, so it cannot be finished by buying): its best grade and
 * the highest grade that is entirely buyable (null when no grade is). Null
 * when the best grade is already fully on the market — nothing to suggest. */
export function futggBuyableAlternative(set: FutggSetSummary): { best: FutggTier; buyable: FutggTier | null } | null {
  const best = bestFutggTier(set);
  if (!best || (best.sbc ?? 0) === 0) return null;
  return { best, buyable: bestBuyableFutggTier(set) };
}

/** The SBC/Objective cards of a lineup, named "<rating> <name>": the cards not
 * on the transfer market (fut.gg prices them below a sale). Used to tell the
 * trader which card blocks a Set's best grade, so they know what to complete in
 * the game to upgrade to it. */
export function futggSbcCards(lineup: FutggLineup): string[] {
  return lineup.cards
    .filter((c) => c.price < MIN_SALE_PRICE)
    .map((c) => `${c.rating} ${c.name}`.slice(0, GALLERY_LIMITS.nameLength + 4));
}

/** The Sets the picker offers: each Set once, at its best grade, by fut.gg's
 * categories, cheapest first in each. The trader sees a Set at its highest
 * grade only — not once per grade — so a Set that reaches S is not also
 * listed under A, B, C and D. */
export function futggBestChoices(sets: readonly FutggSetSummary[]): FutggChoiceGroup[] {
  const groups = new Map<string, FutggChoiceGroup>();
  for (const set of sets) {
    const tier = bestFutggTier(set);
    if (!tier) continue;
    const group = groups.get(set.category) ?? { category: set.category, choices: [] };
    group.choices.push({ set, tier });
    groups.set(set.category, group);
  }
  for (const g of groups.values()) g.choices.sort((a, b) => a.tier.cost - b.tier.cost || a.set.name.localeCompare(b.set.name));
  return [...groups.values()];
}

export interface GalleryUpgrade {
  setId: number;
  name: string;
  /** The grade the Set was completed at. */
  from: GalleryGrade;
  /** The higher grade fut.gg now has a lineup for. */
  to: GalleryGrade;
  /** fut.gg's best tier now (what `to` costs and needs). */
  tier: FutggTier;
}

/**
 * Completed Sets fut.gg now grades higher than they were completed at: new
 * cards have raised the Set's best grade since, so the trader can upgrade it,
 * reusing every card already owned and buying only what the higher grade
 * adds. Needs the grade each was completed at (`completedGrade`); a Set
 * completed before that was kept, or that fut.gg no longer lists, is left out.
 */
export function galleryUpgradable(state: GalleryState, sets: readonly FutggSetSummary[]): GalleryUpgrade[] {
  const completed = new Set(state.completed ?? []);
  const byId = new Map(sets.map((s) => [s.id, s]));
  const upgrades: GalleryUpgrade[] = [];
  for (const id of completed) {
    const from = state.completedGrade?.[String(id)];
    const set = byId.get(id);
    if (from === undefined || !set) continue;
    const best = bestFutggTier(set);
    if (!best || GALLERY_GRADES.indexOf(best.grade) <= GALLERY_GRADES.indexOf(from)) continue;
    upgrades.push({ setId: id, name: set.name, from, to: best.grade, tier: best });
  }
  return upgrades;
}

export interface FutggPlan {
  /** The lineup to collect: fut.gg's, with owned players standing in. */
  cards: FutggCard[];
  swaps: { out: FutggCard; in: FutggCard }[];
  /** Its score (fut.gg's when nothing was swapped). */
  score: number;
  /** Whether the Set's score could be worked out as fut.gg works it out
   * (without that, nothing is swapped). */
  scored: boolean;
}

/**
 * fut.gg's lineup with the club's own players standing in for cards still
 * to buy, dearest first. A player stands in only when he is on the Set's
 * card list, the club holds him (`owned`), he scores at least what the card
 * he replaces scores, and the Set still makes its grade with him — scored
 * as fut.gg scores it, bonus tags included (gallery-score.ts). That score is
 * trusted only when it gives fut.gg's own score for fut.gg's lineup; when it
 * does not (or a tag's rule is unknown), nothing is swapped.
 */
export function planFutggSwaps(lineup: FutggLineup, owned: ReadonlySet<number>): FutggPlan {
  const tier = lineup.set.tiers.find((t) => t.grade === lineup.grade);
  const plain: FutggPlan = { cards: lineup.cards, swaps: [], score: tier?.score ?? 0, scored: false };
  if (!tier || !lineup.tags || lineup.missing > 0) return plain;
  const score = (cards: readonly FutggCard[]): number | null => {
    try {
      return galleryScore(cards, lineup.tags!);
    } catch {
      return null;
    }
  };
  if (score(lineup.cards) !== tier.score) return plain;
  const plan: FutggPlan = { ...plain, scored: true };
  const standIns = (lineup.others ?? []).filter((c) => owned.has(c.resourceId)).sort((a, b) => b.score - a.score);
  const toBuy = lineup.cards.filter((c) => !owned.has(c.resourceId)).sort((a, b) => b.price - a.price);
  const used = new Set<number>();
  let cards = [...lineup.cards];
  for (const out of toBuy) {
    for (const standIn of standIns) {
      if (used.has(standIn.resourceId) || standIn.score < out.score) continue;
      const trial = cards.map((c) => (c === out ? standIn : c));
      const s = score(trial);
      if (s == null || s < tier.threshold) continue;
      cards = trial;
      used.add(standIn.resourceId);
      plan.swaps.push({ out, in: standIn });
      plan.score = s;
      break;
    }
  }
  plan.cards = cards;
  return plan;
}

export interface AddedLineup {
  state: GalleryState;
  /** Cards put on the list, and lineup cards it holds already (another
   * Set's: one card counts for several Sets). */
  added: number;
  already: number;
  /** Of the cards added, those the club holds (not bought), and the club's
   * players standing in for lineup cards. */
  owned: number;
  /** Of the cards added, those fut.gg has no market price for: an
   * SBC/Objective (or untradeable) card, added as `sbc` and never searched
   * for or bought — the trader earns it in the game. */
  sbc: number;
  swaps: FutggPlan['swaps'];
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
export function addFutggLineup(
  state: GalleryState,
  lineup: FutggLineup,
  rarities: readonly CatalogOption[],
  owned: ReadonlySet<number> = new Set(),
  upgrade?: GallerySet['upgrade'],
): AddedLineup {
  const problems: string[] = [];
  const set = lineup.set;
  const tier = set.tiers.find((t) => t.grade === lineup.grade);
  const sets = (state.sets ?? []).filter((s) => s.id !== set.id);
  const none = { state, added: 0, already: 0, owned: 0, sbc: 0, swaps: [] };
  if (!tier) return { ...none, problems: [`${set.name}: fut.gg has no grade ${lineup.grade} lineup`] };
  if (sets.length >= GALLERY_LIMITS.sets) return { ...none, problems: [`The list holds at most ${GALLERY_LIMITS.sets} Sets`] };
  const plan = planFutggSwaps(lineup, owned);
  // The Set's substitute cards: its other cards not in the lineup and not
  // already owned, cheapest (lowest score) first, so one can stand in for a
  // lineup card that turns out not to be on the market (an SBC/Objective card).
  const inLineup = new Set(plan.cards.map((c) => c.resourceId));
  const spares = (lineup.others ?? [])
    .filter((o) => o.score > 0 && !inLineup.has(o.resourceId) && !owned.has(o.resourceId))
    .sort((a, b) => a.score - b.score)
    .slice(0, GALLERY_LIMITS.spares)
    .map((o) => ({ resourceId: o.resourceId, playerId: o.playerId, name: o.name.slice(0, GALLERY_LIMITS.nameLength), rating: o.rating, score: o.score }));
  // Each grade the Set can reach and the score it needs, so a swap that drops
  // the lineup's score can relabel the Set to the grade it then reaches.
  const tiers = set.tiers.filter((t) => t.cards > 0).map((t) => ({ grade: t.grade, threshold: t.threshold }));
  const entry: GallerySet = {
    id: set.id,
    name: set.name,
    path: set.path,
    grade: lineup.grade,
    threshold: tier.threshold,
    score: plan.score,
    tokens: tier.tokens,
    cost: tier.cost - plan.swaps.reduce((sum, x) => sum + x.out.price, 0),
    ...(tiers.length ? { tiers } : {}),
    ...(spares.length ? { spares } : {}),
    ...(upgrade && GALLERY_GRADES.indexOf(upgrade.grade) > GALLERY_GRADES.indexOf(lineup.grade) ? { upgrade } : {}),
  };
  const rarityIds = new Set(rarities.map((r) => r.id));
  const cards = state.cards.map((c) => ({ ...c }));
  const byKey = new Map(cards.map((c) => [c.key, c]));
  let added = 0;
  let already = 0;
  let ownedCount = 0;
  let sbcCount = 0;
  for (const f of plan.cards) {
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
    // fut.gg prices a lineup card it saw no listing for at 0: it is not on
    // the transfer market (an SBC/Objective or otherwise untradeable card),
    // so it is added as `sbc` — never bought, never searched — and the trader
    // earns it in the game. The club's own copy still stands in (`owned`).
    const tradeable = f.price >= MIN_SALE_PRICE;
    const status: GalleryCard['status'] = owned.has(f.resourceId) ? 'owned' : tradeable ? 'todo' : 'sbc';
    const card: GalleryCard = {
      key,
      name: f.name.slice(0, GALLERY_LIMITS.nameLength),
      rating: f.rating,
      playerId: f.playerId,
      resourceId: f.resourceId,
      exact: true,
      status,
      set: set.name.slice(0, GALLERY_LIMITS.setLength),
      setIds: [set.id],
      score: f.score,
      ...(tradeable ? { guide: f.price } : {}),
      ...(status === 'sbc' ? { note: 'Not on the transfer market (SBC/Objective) — collect it in the game' } : {}),
      ...(special && rarityIds.has(f.rarity) ? { rarity: f.rarity } : {}),
      ...(version ? { version: version.slice(0, GALLERY_LIMITS.versionLength) } : {}),
    };
    cards.push(card);
    byKey.set(key, card);
    added++;
    if (card.status === 'owned') ownedCount++;
    else if (card.status === 'sbc') sbcCount++;
  }
  if (lineup.missing > 0) {
    problems.push(
      `${set.name}: fut.gg does not describe ${lineup.missing} of its lineup ${lineup.missing === 1 ? 'card' : 'cards'}, so ${lineup.missing === 1 ? 'it was' : 'they were'} left out and the Set may miss grade ${lineup.grade}`,
    );
  }
  return { state: { ...state, cards, sets: [...sets, entry] }, added, already, owned: ownedCount, sbc: sbcCount, swaps: plan.swaps, problems };
}

/** The card ids the club should be asked about for these lineups: every
 * lineup card first, then each Set's other cards by score, at most `max`. */
export function futggClubIds(lineups: readonly FutggLineup[], max = 100): number[] {
  const ids = new Set<number>();
  for (const l of lineups) for (const c of l.cards) if (ids.size < max) ids.add(c.resourceId);
  for (const l of lineups) for (const c of l.others ?? []) if (ids.size < max) ids.add(c.resourceId);
  return [...ids];
}

/** When each of `ids` (the Sets marked completed) was marked: `now` for
 * those in `fresh`, else what the list says. Only theirs, so it never holds
 * a Set the list no longer marks; undefined when none has a time. */
function completedTimes(state: GalleryState, ids: readonly number[], fresh: ReadonlySet<number>, now: number): Record<string, number> | undefined {
  const at: Record<string, number> = {};
  for (const id of ids) {
    const t = fresh.has(id) ? now : state.completedAt?.[String(id)];
    if (t !== undefined) at[String(id)] = t;
  }
  return Object.keys(at).length > 0 ? at : undefined;
}

/** The grade each of `ids` (the Sets marked completed) was completed at:
 * `fresh`'s grade for those just marked, else what the list already kept.
 * Only theirs, so it never holds a Set the list no longer marks; undefined
 * when none has a grade. */
function completedGrades(state: GalleryState, ids: readonly number[], fresh: ReadonlyMap<number, GalleryGrade>): Record<string, GalleryGrade> | undefined {
  const grades: Record<string, GalleryGrade> = {};
  for (const id of ids) {
    const grade = fresh.get(id) ?? state.completedGrade?.[String(id)];
    if (grade !== undefined) grades[String(id)] = grade;
  }
  return Object.keys(grades).length > 0 ? grades : undefined;
}

/** Marks every fut.gg Set whose cards are all collected (in the club,
 * listed, or owned already) as completed, at `now`. Returns the Sets it
 * marked. */
export function markCompletedSets(state: GalleryState, now = Date.now()): GallerySet[] {
  const done = new Set(state.completed ?? []);
  const marked: GallerySet[] = [];
  for (const set of state.sets ?? []) {
    if (done.has(set.id)) continue;
    const mine = state.cards.filter((c) => c.setIds?.includes(set.id));
    if (mine.length === 0 || !mine.every((c) => c.status === 'owned' || c.status === 'club' || c.status === 'listed')) continue;
    done.add(set.id);
    marked.push(set);
  }
  if (marked.length > 0) {
    state.completed = [...done].slice(-GALLERY_LIMITS.completed);
    const at = completedTimes(state, state.completed, new Set(marked.map((x) => x.id)), now);
    if (at) state.completedAt = at;
    else delete state.completedAt;
    const grades = completedGrades(state, state.completed, new Map(marked.map((x) => [x.id, x.grade])));
    if (grades) state.completedGrade = grades;
    else delete state.completedGrade;
  }
  return marked;
}

/**
 * The list with what is finished cleared away (Reset stats): the cards that
 * are done (listed, in the club, or left out for a completed Set) and that
 * no Set in progress counts, the cards bought on an earlier page load that
 * Nova can no longer finish, and the completed Sets (they stay marked
 * completed, so the picker still does not offer them). Cards still to buy,
 * the cards of Sets in progress and the cards Nova is still finishing stay.
 * What the list spent goes back to 0.
 */
export function clearFinishedGallery(state: GalleryState, now = Date.now()): GalleryState {
  const marked: GalleryState = { ...state, cards: state.cards.map((c) => ({ ...c })) };
  markCompletedSets(marked, now);
  const done = new Set(marked.completed ?? []);
  const inProgress = new Set((marked.sets ?? []).filter((s) => !done.has(s.id)).map((s) => s.id));
  const cards = marked.cards.filter((c) => {
    if (c.setIds?.some((id) => inProgress.has(id))) return true;
    if (c.status === 'todo' || c.status === 'skipped' || c.status === 'sbc') return galleryCardNeeded(c, marked);
    if (c.status === 'bought' || c.status === 'club') return c.tradeId !== undefined;
    return false;
  });
  const sets = (marked.sets ?? []).filter((s) => inProgress.has(s.id));
  const next: GalleryState = { ...marked, cards, spent: 0 };
  if (sets.length > 0) next.sets = sets;
  else delete next.sets;
  return next;
}

/** The list with a fut.gg Set marked completed (at `now`, unless it was
 * already), or not. */
export function setCompleted(state: GalleryState, setId: number, completed: boolean, now = Date.now()): GalleryState {
  const was = state.completed?.includes(setId) ?? false;
  const ids = (state.completed ?? []).filter((id) => id !== setId);
  if (completed) ids.push(setId);
  const next: GalleryState = { ...state };
  if (ids.length > 0) next.completed = ids.slice(-GALLERY_LIMITS.completed);
  else delete next.completed;
  const at = completedTimes(state, next.completed ?? [], new Set(completed && !was ? [setId] : []), now);
  if (at) next.completedAt = at;
  else delete next.completedAt;
  // The grade it was completed at: the Set entry's grade when it is on the
  // list, so an upgrade later knows the grade to beat.
  const freshGrade = completed && !was ? (state.sets ?? []).find((s) => s.id === setId)?.grade : undefined;
  const grades = completedGrades(state, next.completed ?? [], new Map(freshGrade ? [[setId, freshGrade]] : []));
  if (grades) next.completedGrade = grades;
  else delete next.completedGrade;
  return next;
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

export interface GallerySubstitution {
  state: GalleryState;
  /** The un-buyable card routed around (named for the log/note). */
  blocked: string;
  /** The substitute put on the list in its place. */
  spare: string;
  setName: string;
  /** The grade the Set now reaches with the swap. */
  grade: GalleryGrade;
  /** True when the swap kept the Set's grade; false when it dropped. */
  keptGrade: boolean;
}

/**
 * Routes a Set around a card that is not on the transfer market — an
 * SBC/Objective card fut.gg still prices, so it reads as "to buy" but never
 * lists. The Set's cheapest buyable spare takes its place: one that keeps the
 * Set's grade if any does (the recommended, same-tier path), else the best
 * that is left, and the Set is relabelled to the grade it then reaches (a
 * downgrade finished with buyable players). The blocked card loses this Set
 * (dropped if it serves no other), so the Set's count stays right.
 *
 * Returns null when the card is not an `exact` Set card, or no Set it belongs
 * to has an unused spare — the caller then leaves the card out as before.
 */
export function gallerySubstitute(state: GalleryState, card: GalleryCard): GallerySubstitution | null {
  if (!card.exact || !card.setIds?.length) return null;
  const sets = state.sets ?? [];
  const hasKey = (sp: GallerySpare): boolean => state.cards.some((c) => c.key === galleryKey(sp.playerId, sp.rating, undefined, sp.resourceId));
  for (const setId of card.setIds) {
    const entry = sets.find((s) => s.id === setId);
    const usable = (entry?.spares ?? []).filter((sp) => !hasKey(sp));
    if (!entry || usable.length === 0) continue;
    // The lineup's score once this card is gone and a spare stands in.
    const base = entry.score - (card.score ?? 0);
    // Prefer the cheapest (lowest score) spare that still clears the grade;
    // else the highest-score spare left, to drop the grade as little as can be.
    const keepers = usable.filter((sp) => base + sp.score >= entry.threshold).sort((a, b) => a.score - b.score);
    const spare = keepers[0] ?? [...usable].sort((a, b) => b.score - a.score)[0]!;
    const newScore = base + spare.score;
    const keptGrade = newScore >= entry.threshold;
    const grade = keptGrade
      ? entry.grade
      : ((entry.tiers ?? [])
          .filter((t) => newScore >= t.threshold)
          .map((t) => t.grade)
          .sort((a, b) => GALLERY_GRADES.indexOf(b) - GALLERY_GRADES.indexOf(a))[0] ?? entry.grade);
    // Drop the Set from the blocked card (remove it if it serves no other).
    const cards: GalleryCard[] = [];
    for (const c of state.cards) {
      if (c.key !== card.key) {
        cards.push(c);
        continue;
      }
      const rest = (c.setIds ?? []).filter((id) => id !== setId);
      if (rest.length > 0) cards.push({ ...c, setIds: rest });
    }
    cards.push({
      key: galleryKey(spare.playerId, spare.rating, undefined, spare.resourceId),
      name: spare.name.slice(0, GALLERY_LIMITS.nameLength),
      rating: spare.rating,
      playerId: spare.playerId,
      resourceId: spare.resourceId,
      exact: true,
      status: 'todo',
      set: entry.name.slice(0, GALLERY_LIMITS.setLength),
      setIds: [setId],
      score: spare.score,
    });
    const nextSets = sets.map((s) =>
      s.id === setId
        ? {
            ...s,
            grade,
            score: newScore,
            threshold: (s.tiers ?? []).find((t) => t.grade === grade)?.threshold ?? s.threshold,
            spares: (s.spares ?? []).filter((x) => x.resourceId !== spare.resourceId),
          }
        : s,
    );
    return {
      state: { ...state, cards, sets: nextSets },
      blocked: `${card.rating} ${card.name}`,
      spare: `${spare.rating} ${spare.name}`,
      setName: entry.name,
      grade,
      keptGrade,
    };
  }
  return null;
}

/** The exact cards whose club the trader should be asked about: fut.gg
 * lineup cards still to buy (or skipped), at most `max`. */
export function clubCheckIds(state: GalleryState, max = 100): number[] {
  const ids = new Set<number>();
  for (const c of state.cards) {
    if (!c.exact || c.resourceId === undefined || (c.status !== 'todo' && c.status !== 'skipped') || !galleryCardNeeded(c, state)) continue;
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
  /** Lineup cards on the list, and those collected: a card counts only once
   * it has been through the club (in the club, listed, or owned already) —
   * the same statuses that complete a Set. A card merely bought, not yet in
   * the club, is still on its way, so it is not counted (nor would it
   * complete the Set). */
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
      done: mine.filter((c) => c.status === 'owned' || c.status === 'club' || c.status === 'listed').length,
      skipped: skipped.length,
      skippedScore: skipped.reduce((sum, c) => sum + (c.score ?? 0), 0),
    };
  });
}

/** Why a card a Set still needs is not collected: still to buy, nobody has
 * listed it, an SBC/Objective off the market, or bought and on its way. */
export type GallerySetBlockerReason = 'buy' | 'skipped' | 'sbc' | 'collecting';

export interface GallerySetBlockerCard {
  name: string;
  rating: number;
  version?: string;
  /** fut.gg's price, when known: a card that sits unbought is usually the
   * dear/scarce one, which this shows. */
  guide?: number;
}

export interface GallerySetBlocker {
  reason: GallerySetBlockerReason;
  cards: GallerySetBlockerCard[];
}

const BLOCKER_ORDER: GallerySetBlockerReason[] = ['buy', 'skipped', 'sbc', 'collecting'];

/**
 * Why a Set is not completed: the cards it still needs (not yet through the
 * club), grouped by the reason each is not collected — so each uncompleted
 * Set can say what is holding it up. Empty for a completed Set, or one whose
 * every card is collected (in the club, listed, or owned already).
 */
export function gallerySetBlockers(state: GalleryState, setId: number): GallerySetBlocker[] {
  if ((state.completed ?? []).includes(setId)) return [];
  const groups = new Map<GallerySetBlockerReason, GallerySetBlocker>();
  for (const c of state.cards) {
    if (!c.setIds?.includes(setId)) continue;
    if (c.status === 'owned' || c.status === 'club' || c.status === 'listed') continue;
    const reason: GallerySetBlockerReason =
      c.status === 'sbc' ? 'sbc' : c.status === 'skipped' ? 'skipped' : c.status === 'bought' ? 'collecting' : 'buy';
    const group = groups.get(reason) ?? { reason, cards: [] };
    group.cards.push({
      name: c.name,
      rating: c.rating,
      ...(c.version ? { version: c.version } : {}),
      ...(c.guide !== undefined ? { guide: c.guide } : {}),
    });
    groups.set(reason, group);
  }
  return BLOCKER_ORDER.filter((r) => groups.has(r)).map((r) => groups.get(r)!);
}
