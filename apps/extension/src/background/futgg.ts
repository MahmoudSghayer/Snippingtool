/*
 * futgg.ts — fut.gg's FC Gallery, for Nova AI's Gallery mode
 * (`gallery.futggSets` / `gallery.futggLineup`, automation builds only).
 *
 * fut.gg publishes no API documentation. This reads the JSON its own
 * Gallery pages load:
 *
 *   GET https://www.fut.gg/api/fut/gallery/fc{year}/hub/
 *   -> { data: { categories: [{ name, slug, sets: [{ id, name, slug,
 *          requiredCards, ... }] }],
 *        sets: [{ setId, costTiers: [{ grade, threshold, tokens, cost,
 *          peakPrice, totalScore, items: [{ eaId, price }] }] }] } }
 *
 * where each cost tier is fut.gg's cheapest lineup for that grade (its own
 * solver, prices as of `computedAt`), and
 *
 *   GET https://www.fut.gg/api/fut/gallery/fc{year}/sets/{setId}/pool/
 *   -> { data: { items: [{ eaId, playerEaId, commonName, overall,
 *          rarityEaId, rarityName, holographic, score, ... }] } }
 *
 * the cards that count for the Set, which name the lineup's cards. `eaId` is
 * EA's own card id (a version's `resourceId`), `playerEaId` the player's.
 * fut.gg can change or block this at any time, so anything that does not
 * read exactly like that is left out, and a page that reads nothing is
 * "no Sets" (null). Both are reused for a few minutes.
 */
import {
  GALLERY_GRADES,
  futggLineupSchema,
  futggSetSummarySchema,
  type FutggCard,
  type FutggLineup,
  type FutggSetSummary,
  type GalleryGrade,
} from '@sl/shared';

import { externalFetch } from '../lib/http.js';

import { futbinYear } from './futbin.js';

const CACHE_TTL_MS = 10 * 60_000;
const MAX_POOLS = 50;

type Obj = Record<string, unknown>;

interface Hub {
  sets: FutggSetSummary[];
  /** Each Set's cheapest lineup per grade: card ids and prices. */
  lineups: Map<number, Map<GalleryGrade, { resourceId: number; price: number }[]>>;
}

let hubCache: { at: number; hub: Hub | null } | null = null;
const poolCache = new Map<number, { at: number; pool: Map<number, Obj> | null }>();

const base = (): string => `https://www.fut.gg/api/fut/gallery/fc${futbinYear()}`;

const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const isGrade = (v: unknown): v is GalleryGrade => typeof v === 'string' && (GALLERY_GRADES as readonly string[]).includes(v);

/** fut.gg's hub as Set summaries (D first, each grade the Set reaches) and
 * the cards of each grade's lineup. */
export function parseFutggHub(json: unknown): Hub | null {
  const data = obj(obj(json)?.data);
  if (!data) return null;
  const sets: FutggSetSummary[] = [];
  const lineups: Hub['lineups'] = new Map();
  const solved = new Map<number, Obj>();
  for (const s of arr(data.sets)) {
    const id = int(obj(s)?.setId);
    if (id) solved.set(id, obj(s)!);
  }
  for (const c of arr(data.categories)) {
    const category = obj(c);
    const catSlug = str(category?.slug);
    for (const raw of arr(category?.sets)) {
      const set = obj(raw);
      const id = int(set?.id);
      const slug = str(set?.slug);
      if (!id || !catSlug || !slug) continue;
      const tiers: FutggSetSummary['tiers'] = [];
      const cards = new Map<GalleryGrade, { resourceId: number; price: number }[]>();
      for (const t of arr(solved.get(id)?.costTiers)) {
        const tier = obj(t);
        if (!tier || !isGrade(tier.grade)) continue;
        const items = arr(tier.items).flatMap((i) => {
          const resourceId = int(obj(i)?.eaId);
          const price = int(obj(i)?.price);
          return resourceId && price != null ? [{ resourceId, price }] : [];
        });
        const threshold = int(tier.threshold);
        const tokens = int(tier.tokens);
        const cost = int(tier.cost);
        const peak = int(tier.peakPrice);
        const score = int(tier.totalScore);
        if (threshold == null || tokens == null || cost == null || peak == null || score == null) continue;
        tiers.push({ grade: tier.grade, threshold, tokens, cost, peak, score, cards: items.length });
        cards.set(tier.grade, items);
      }
      tiers.sort((a, b) => GALLERY_GRADES.indexOf(a.grade) - GALLERY_GRADES.indexOf(b.grade));
      const summary = futggSetSummarySchema.safeParse({
        id,
        name: str(set!.name),
        category: str(category!.name) ?? '',
        path: `${catSlug}/${slug}`,
        requiredCards: int(set!.requiredCards) ?? 0,
        tiers,
      });
      if (!summary.success) continue;
      sets.push(summary.data);
      lineups.set(id, cards);
    }
  }
  return sets.length > 0 ? { sets, lineups } : null;
}

/** A Set's cards, by EA card id. */
export function parseFutggPool(json: unknown): Map<number, Obj> | null {
  const items = arr(obj(obj(json)?.data)?.items);
  const pool = new Map<number, Obj>();
  for (const i of items) {
    const id = int(obj(i)?.eaId);
    if (id) pool.set(id, obj(i)!);
  }
  return pool.size > 0 ? pool : null;
}

/** One card of the lineup as Gallery mode buys it, or null when the pool
 * does not describe it well enough to search for. */
function lineupCard(item: { resourceId: number; price: number }, card: Obj | undefined): FutggCard | null {
  if (!card) return null;
  const playerId = int(card.playerEaId);
  const name = str(card.commonName) ?? str(card.cardName);
  const rating = int(card.overall);
  const rarity = int(card.rarityEaId);
  const score = int(card.score);
  if (!playerId || !name || rating == null || rarity == null || score == null) return null;
  return {
    resourceId: item.resourceId,
    playerId,
    name: name.slice(0, 60),
    rating,
    rarity,
    version: (str(card.rarityName) ?? '').slice(0, 40),
    holographic: card.holographic === true,
    score,
    price: item.price,
  };
}

async function getJson(url: string): Promise<unknown> {
  const res = await externalFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fut.gg answered ${res.status}`);
  return JSON.parse(await res.text()) as unknown;
}

async function hub(): Promise<Hub | null> {
  if (hubCache && Date.now() - hubCache.at < CACHE_TTL_MS && hubCache.hub) return hubCache.hub;
  let parsed: Hub | null = null;
  try {
    parsed = parseFutggHub(await getJson(`${base()}/hub/`));
  } catch {
    // Unreachable, blocked, or not JSON: no Sets.
  }
  hubCache = { at: Date.now(), hub: parsed };
  return parsed;
}

async function pool(setId: number): Promise<Map<number, Obj> | null> {
  const hit = poolCache.get(setId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && hit.pool) return hit.pool;
  let parsed: Map<number, Obj> | null = null;
  try {
    parsed = parseFutggPool(await getJson(`${base()}/sets/${setId}/pool/`));
  } catch {
    // As for the hub.
  }
  if (poolCache.size >= MAX_POOLS) poolCache.clear();
  poolCache.set(setId, { at: Date.now(), pool: parsed });
  return parsed;
}

export async function handleFutggSets(): Promise<{ sets: FutggSetSummary[] | null }> {
  return { sets: (await hub())?.sets ?? null };
}

/** The Set's cheapest lineup for `grade`, its cards named from the Set's
 * card list; null when fut.gg has none (or answers nothing readable). */
export async function handleFutggLineup(payload: { setId: number; grade: GalleryGrade }): Promise<{ lineup: FutggLineup | null }> {
  const h = await hub();
  const set = h?.sets.find((s) => s.id === payload.setId);
  const items = h?.lineups.get(payload.setId)?.get(payload.grade);
  if (!set || !items || items.length === 0) return { lineup: null };
  const cards = await pool(payload.setId);
  if (!cards) return { lineup: null };
  const named = items.map((i) => lineupCard(i, cards.get(i.resourceId)));
  const lineup = futggLineupSchema.safeParse({
    set,
    grade: payload.grade,
    cards: named.filter((c): c is FutggCard => c !== null),
    missing: named.filter((c) => c === null).length,
  });
  return { lineup: lineup.success ? lineup.data : null };
}

/** Tests: forget what was fetched. */
export function resetFutggCache(): void {
  hubCache = null;
  poolCache.clear();
}
