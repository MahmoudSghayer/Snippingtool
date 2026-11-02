/*
 * gallery-score.ts — a fut.gg Gallery Set's score for a set of cards, as
 * fut.gg's own solver works it out (engine/gallery.ts uses it before it lets
 * an owned card stand in for a lineup card):
 *
 *   the cards' own scores, plus, for each bonus tag whose rule enough cards
 *   match (its highest tier with `minItems` at or under that count), that
 *   tier's percentage of the matching cards' scores, rounded down.
 *
 * The rules, as fut.gg's tags state them (checked against fut.gg's scores for
 * every Set's cheapest lineups, Oct 2026: 337 of 348 match exactly, the rest
 * are Sets of many special cards):
 *   MAX_COUNT_ALL_SAME  the biggest group of cards sharing the attribute;
 *                       every group of that size counts
 *   COUNT_DIFF          one card per value (the best scoring one)
 *   COUNT / COUNT_ANY   cards whose value (or any of whose values) is listed
 *   MIN_COUNT           cards at or over the listed value
 * on these attributes: NATION, CLUB, LEAGUEID, LEVEL (gold from 75, silver
 * from 65, else bronze), RARE (EA's rarity id), HYPER_COSMETIC_TYPE
 * (holographic), POSSIBLE_POSITIONS, WEAK_FOOT, SKILL_MOVES (EA counts
 * them from 0: five stars is 4), BASE_DEF_ID (the player) and FIRST_OWNED
 * (never: Nova buys every card). A rule or attribute it does not know
 * throws: a score it cannot work out is never guessed.
 */
import type { FutggCard, FutggTag } from '@sl/shared';

export class UnknownTagRule extends Error {}

type Value = number | string | null;

function attribute(card: FutggCard, name: string): Value | Value[] {
  switch (name) {
    case 'NATION':
      return card.nation ?? null;
    case 'CLUB':
      return card.club ?? null;
    case 'LEAGUEID':
      return card.league ?? null;
    case 'LEVEL':
      return card.rating >= 75 ? 'gold' : card.rating >= 65 ? 'silver' : 'bronze';
    case 'RARE':
      return card.rarity;
    case 'HYPER_COSMETIC_TYPE':
      return card.holographic ? 1 : null;
    case 'POSSIBLE_POSITIONS':
      return card.positions ?? [];
    case 'WEAK_FOOT':
      return card.weakFoot ?? null;
    case 'SKILL_MOVES':
      return card.skillMoves == null ? null : card.skillMoves - 1;
    case 'BASE_DEF_ID':
      return card.playerId;
    case 'FIRST_OWNED':
      return 0;
    default:
      throw new UnknownTagRule(`attribute ${name}`);
  }
}

/** The cards a tag's rule matches, and the count its tiers go by. */
function matching(cards: readonly FutggCard[], rule: FutggTag['rule']): { cards: FutggCard[]; count: number } {
  const value = (c: FutggCard) => attribute(c, rule.attribute);
  const listed = new Set(rule.values);
  switch (rule.type) {
    case 'MAX_COUNT_ALL_SAME': {
      const groups = new Map<string, FutggCard[]>();
      for (const c of cards) {
        const v = value(c);
        if (v == null || Array.isArray(v)) continue;
        const key = String(v);
        const group = groups.get(key);
        if (group) group.push(c);
        else groups.set(key, [c]);
      }
      let most = 0;
      for (const g of groups.values()) if (g.length > most) most = g.length;
      return { cards: [...groups.values()].filter((g) => g.length === most).flat(), count: most };
    }
    case 'COUNT_DIFF': {
      const best = new Map<string, FutggCard>();
      for (const c of cards) {
        const v = value(c);
        if (v == null || Array.isArray(v)) continue;
        const key = String(v);
        const held = best.get(key);
        if (!held || c.score > held.score) best.set(key, c);
      }
      return { cards: [...best.values()], count: best.size };
    }
    case 'COUNT':
    case 'COUNT_ANY': {
      const hit = cards.filter((c) => {
        const v = value(c);
        const values = Array.isArray(v) ? v : v == null ? [] : [v];
        return values.some((x) => listed.has(String(x)));
      });
      return { cards: hit, count: hit.length };
    }
    case 'MIN_COUNT': {
      const least = Number(rule.values[0]);
      if (!Number.isFinite(least)) throw new UnknownTagRule(`MIN_COUNT value ${rule.values[0]}`);
      const hit = cards.filter((c) => {
        const v = value(c);
        return typeof v === 'number' && v >= least;
      });
      return { cards: hit, count: hit.length };
    }
    default:
      throw new UnknownTagRule(`rule ${rule.type}`);
  }
}

/** The Set's score for `cards` under its bonus tags (throws UnknownTagRule
 * on a rule it cannot work out). */
export function galleryScore(cards: readonly FutggCard[], tags: readonly FutggTag[]): number {
  let total = cards.reduce((sum, c) => sum + c.score, 0);
  for (const tag of tags) {
    const m = matching(cards, tag.rule);
    let pct = 0;
    for (const tier of tag.tiers) if (m.count >= tier.minItems && tier.minItems > 0) pct = Math.max(pct, tier.bonus);
    if (pct > 0) total += Math.floor((m.cards.reduce((sum, c) => sum + c.score, 0) * pct) / 100);
  }
  return total;
}
