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
 * the cards that count for the Set, which name the lineup's cards (and,
 * with what the Set's bonus tags look at, let owned cards stand in for
 * them), and
 *
 *   GET https://www.fut.gg/api/fut/gallery/fc{year}/sets/{category}/{set}/
 *   -> { data: { tags: [{ id, name, tiers: [{ minItems, bonus }],
 *          rules: [{ type, attribute, values }] }] } }
 *
 * the bonus tags a Set's score counts. `eaId` is EA's own card id (a
 * version's `resourceId`), `playerEaId` the player's.
 * fut.gg can change or block this at any time, so anything that does not
 * read exactly like that is left out, and a page that reads nothing is
 * "no Sets" (null). Both are reused for a few minutes.
 */
import {
  GALLERY_GRADES,
  MIN_SALE_PRICE,
  futggLineupSchema,
  futggSetSummarySchema,
  futggTagSchema,
  type FutggCard,
  type FutggLineup,
  type FutggSetSummary,
  type FutggTag,
  type GalleryGrade,
} from '@sl/shared';

import { externalFetch } from '../lib/http.js';
import { perf } from '../lib/perf.js';
import { getSession, removeSession, setSession } from '../lib/storage.js';

import { futbinYear } from './futbin.js';

const CACHE_TTL_MS = 10 * 60_000;
/** How long a failed read (unreachable, blocked, unreadable) is remembered
 * before fut.gg is asked again: a site that is down is not asked on every
 * click meanwhile. */
const FAILED_TTL_MS = 60_000;
const MAX_POOLS = 50;
/** No answer in this long: given up (the picker says "try again"). */
const FETCH_TIMEOUT_MS = 15_000;
/** The hub, kept in `storage.session` as well as memory: an MV3 service
 * worker is stopped after a short idle, and the hub (hundreds of Sets) is
 * the one read worth keeping across that. Bounded, so a hub larger than
 * session storage's quota is not even tried. */
const HUB_SESSION_KEY = 'sl.futgg.hub.v1';
const HUB_SESSION_MAX_BYTES = 800_000;

type Obj = Record<string, unknown>;

interface Hub {
  sets: FutggSetSummary[];
  /** Each Set's cheapest lineup per grade: card ids and prices. */
  lineups: Map<number, Map<GalleryGrade, { resourceId: number; price: number }[]>>;
  /** `sets` by id. */
  byId: Map<number, FutggSetSummary>;
}

/** A Set's card list, and its other cards (not in any lineup read so far)
 * best first, worked out once per pool. */
interface Pool {
  cards: Map<number, Obj>;
  /** Every card of the pool as a lineup card (null: not described well
   * enough), by id, worked out on first use. */
  named: Map<number, FutggCard | null>;
}

let hubCache: { at: number; hub: Hub | null } | null = null;
const poolCache = new Map<number, { at: number; pool: Pool | null }>();
const tagsCache = new Map<string, { at: number; tags: FutggTag[] | null }>();
/** Reads under way, so a second caller joins the first rather than asking
 * fut.gg again (two EA tabs, or the picker and an add). */
let hubFlight: Promise<Hub | null> | null = null;
const poolFlights = new Map<number, Promise<Pool | null>>();
const tagsFlights = new Map<string, Promise<FutggTag[] | null>>();
/** The Set's other cards a lineup carries, best scores first. */
const MAX_OTHERS = 100;

/** Whether a cached read is still good: a value for `CACHE_TTL_MS`, a
 * failure for `FAILED_TTL_MS`. */
const fresh = (at: number, value: unknown, now = Date.now()): boolean => now - at < (value ? CACHE_TTL_MS : FAILED_TTL_MS);

/** Drops the oldest entry once a map is full (insertion order): the one
 * least likely to be asked for again, rather than everything. */
function trim<K, V>(map: Map<K, V>): void {
  if (map.size < MAX_POOLS) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

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
        // A card fut.gg prices under EA's floor is not on the transfer market
        // (an SBC/Objective or otherwise untradeable card): count them so the
        // picker can tell a buyable grade from one that needs cards off-market.
        const sbc = items.filter((i) => i.price < MIN_SALE_PRICE).length;
        tiers.push({ grade: tier.grade, threshold, tokens, cost, peak, score, cards: items.length, sbc });
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
  return sets.length > 0 ? { sets, lineups, byId: new Map(sets.map((x) => [x.id, x])) } : null;
}

/** The hub as `storage.session` keeps it (Maps as entries), and back. */
interface StoredHub {
  at: number;
  sets: FutggSetSummary[];
  lineups: [number, [GalleryGrade, { resourceId: number; price: number }[]][]][];
}

function storedHub(at: number, hub: Hub): StoredHub {
  return { at, sets: hub.sets, lineups: [...hub.lineups].map(([id, grades]) => [id, [...grades]]) };
}

function hubFromStored(raw: unknown): { at: number; hub: Hub } | null {
  const o = obj(raw);
  const at = int(o?.at);
  if (!o || at == null || !Array.isArray(o.sets) || !Array.isArray(o.lineups)) return null;
  const sets: FutggSetSummary[] = [];
  for (const x of o.sets) {
    const parsed = futggSetSummarySchema.safeParse(x);
    if (!parsed.success) return null;
    sets.push(parsed.data);
  }
  const lineups: Hub['lineups'] = new Map();
  for (const entry of o.lineups) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [id, grades] = entry as [unknown, unknown];
    if (!int(id) || !Array.isArray(grades)) return null;
    const byGrade = new Map<GalleryGrade, { resourceId: number; price: number }[]>();
    for (const g of grades) {
      if (!Array.isArray(g) || g.length !== 2 || !isGrade(g[0]) || !Array.isArray(g[1])) return null;
      const items = (g[1] as unknown[]).flatMap((i) => {
        const resourceId = int(obj(i)?.resourceId);
        const price = int(obj(i)?.price);
        return resourceId && price != null ? [{ resourceId, price }] : [];
      });
      byGrade.set(g[0], items);
    }
    lineups.set(id as number, byGrade);
  }
  return sets.length > 0 ? { at, hub: { sets, lineups, byId: new Map(sets.map((x) => [x.id, x])) } } : null;
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

/** A Set's bonus tags, as its page has them: each with its one rule. */
export function parseFutggTags(json: unknown): FutggTag[] | null {
  const tags: FutggTag[] = [];
  for (const t of arr(obj(obj(json)?.data)?.tags)) {
    const tag = obj(t);
    const rules = arr(tag?.rules);
    const rule = obj(rules[0]);
    const id = typeof tag?.id === 'number' && Number.isInteger(tag.id) ? tag.id : null;
    if (id == null || rules.length !== 1 || !rule) return null;
    const tiers = arr(tag!.tiers).flatMap((x) => {
      const minItems = int(obj(x)?.minItems);
      const bonus = obj(x)?.bonus;
      return minItems != null && typeof bonus === 'number' && bonus >= 0 ? [{ minItems, bonus }] : [];
    });
    const parsed = futggTagSchema.safeParse({
      id,
      name: (str(tag!.name) ?? '').slice(0, 60),
      tiers,
      rule: { type: str(rule.type) ?? '', attribute: str(rule.attribute) ?? '', values: arr(rule.values).map(String) },
    });
    // A tag it cannot read: no tags at all, so no score is worked out wrong.
    if (!parsed.success) return null;
    tags.push(parsed.data);
  }
  return tags.length > 0 ? tags : null;
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
  const nation = int(card.nationEaId);
  const club = int(card.clubEaId);
  const league = int(card.leagueEaId);
  const weakFoot = int(card.weakFoot);
  const skillMoves = int(card.skillMoves);
  const positions = arr(card.positions).filter((p): p is string => typeof p === 'string' && p.length <= 4);
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
    ...(nation != null ? { nation } : {}),
    ...(club != null ? { club } : {}),
    ...(league != null ? { league } : {}),
    ...(Array.isArray(card.positions) ? { positions: positions.slice(0, 12) } : {}),
    ...(weakFoot != null && weakFoot <= 5 ? { weakFoot } : {}),
    ...(skillMoves != null && skillMoves <= 5 ? { skillMoves } : {}),
  };
}

async function getJson(url: string): Promise<unknown> {
  // A fetch that never answers would leave the picker on "Loading…" for
  // good: given up after a while instead.
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = abort ? setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await externalFetch(url, { headers: { accept: 'application/json' }, ...(abort ? { signal: abort.signal } : {}) });
    if (!res.ok) throw new Error(`fut.gg answered ${res.status}`);
    return JSON.parse(await res.text()) as unknown;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The hub `storage.session` kept from before this worker started, if it is
 * still fresh. */
async function storedHubRead(): Promise<{ at: number; hub: Hub } | null> {
  try {
    const kept = hubFromStored(await getSession<unknown>(HUB_SESSION_KEY, null));
    return kept && fresh(kept.at, kept.hub) ? kept : null;
  } catch {
    return null;
  }
}

function storedHubWrite(at: number, h: Hub): void {
  try {
    const value = storedHub(at, h);
    if (JSON.stringify(value).length > HUB_SESSION_MAX_BYTES) return;
    void setSession(HUB_SESSION_KEY, value).catch(() => undefined);
  } catch {
    /* no session storage here: memory only, as before */
  }
}

async function hub(): Promise<Hub | null> {
  if (hubCache && fresh(hubCache.at, hubCache.hub)) {
    perf.count('futgg.hub.cached');
    return hubCache.hub;
  }
  if (hubFlight) {
    perf.count('futgg.hub.joined');
    return hubFlight;
  }
  hubFlight = (async () => {
    const kept = await storedHubRead();
    if (kept) {
      perf.count('futgg.hub.fromSession');
      hubCache = kept;
      return kept.hub;
    }
    let parsed: Hub | null = null;
    try {
      parsed = await perf.timeAsync('futgg.hub.fetch', async () => parseFutggHub(await getJson(`${base()}/hub/`)));
    } catch {
      // Unreachable, blocked, or not JSON: no Sets.
    }
    const at = Date.now();
    hubCache = { at, hub: parsed };
    if (parsed) storedHubWrite(at, parsed);
    return parsed;
  })().finally(() => {
    hubFlight = null;
  });
  return hubFlight;
}

async function tags(path: string): Promise<FutggTag[] | null> {
  const hit = tagsCache.get(path);
  if (hit && fresh(hit.at, hit.tags)) return hit.tags;
  const flight = tagsFlights.get(path);
  if (flight) {
    perf.count('futgg.tags.joined');
    return flight;
  }
  const read = (async () => {
    let parsed: FutggTag[] | null = null;
    try {
      parsed = parseFutggTags(await getJson(`${base()}/sets/${path}/`));
    } catch {
      // As for the hub.
    }
    tagsCache.delete(path);
    trim(tagsCache);
    tagsCache.set(path, { at: Date.now(), tags: parsed });
    return parsed;
  })().finally(() => tagsFlights.delete(path));
  tagsFlights.set(path, read);
  return read;
}

async function pool(setId: number): Promise<Pool | null> {
  const hit = poolCache.get(setId);
  if (hit && fresh(hit.at, hit.pool)) return hit.pool;
  const flight = poolFlights.get(setId);
  if (flight) {
    perf.count('futgg.pool.joined');
    return flight;
  }
  const read = (async () => {
    let parsed: Pool | null = null;
    try {
      const cards = parseFutggPool(await getJson(`${base()}/sets/${setId}/pool/`));
      if (cards) parsed = { cards, named: new Map() };
    } catch {
      // As for the hub.
    }
    poolCache.delete(setId);
    trim(poolCache);
    poolCache.set(setId, { at: Date.now(), pool: parsed });
    return parsed;
  })().finally(() => poolFlights.delete(setId));
  poolFlights.set(setId, read);
  return read;
}

/** A pool card as a lineup card, worked out once per pool. */
function namedCard(p: Pool, id: number, price: number): FutggCard | null {
  let card = p.named.get(id);
  if (card === undefined) {
    card = lineupCard({ resourceId: id, price: 0 }, p.cards.get(id));
    p.named.set(id, card);
  }
  return card ? { ...card, price } : null;
}

export async function handleFutggSets(): Promise<{ sets: FutggSetSummary[] | null }> {
  return { sets: (await hub())?.sets ?? null };
}

/** The Set's cheapest lineup for `grade`, its cards named from the Set's
 * card list; null when fut.gg has none (or answers nothing readable). */
export async function handleFutggLineup(payload: { setId: number; grade: GalleryGrade }): Promise<{ lineup: FutggLineup | null }> {
  const h = await hub();
  const set = h?.byId.get(payload.setId);
  const items = h?.lineups.get(payload.setId)?.get(payload.grade);
  if (!set || !items || items.length === 0) return { lineup: null };
  const p = await pool(payload.setId);
  if (!p) return { lineup: null };
  const named = items.map((i) => namedCard(p, i.resourceId, i.price));
  // The Set's other cards, best first: owned ones can stand in for lineup cards.
  const inLineup = new Set(items.map((i) => i.resourceId));
  const others: FutggCard[] = [];
  for (const id of p.cards.keys()) {
    if (inLineup.has(id)) continue;
    const card = namedCard(p, id, 0);
    if (card) others.push(card);
  }
  others.sort((a, b) => b.score - a.score || a.resourceId - b.resourceId);
  const setTags = await tags(set.path);
  const lineup = futggLineupSchema.safeParse({
    set,
    grade: payload.grade,
    cards: named.filter((c): c is FutggCard => c !== null),
    missing: named.filter((c) => c === null).length,
    ...(others.length > 0 ? { others: others.slice(0, MAX_OTHERS) } : {}),
    ...(setTags ? { tags: setTags } : {}),
  });
  return { lineup: lineup.success ? lineup.data : null };
}

/** Tests: what a stopped service worker loses — memory, not session storage. */
export function forgetFutggMemoryForTests(): void {
  hubCache = null;
  poolCache.clear();
  tagsCache.clear();
}

/** Tests: forget what was fetched, the session copy included. */
export async function resetFutggCache(): Promise<void> {
  hubCache = null;
  hubFlight = null;
  poolCache.clear();
  poolFlights.clear();
  tagsCache.clear();
  tagsFlights.clear();
  try {
    await removeSession(HUB_SESSION_KEY);
  } catch {
    /* no session storage here */
  }
}
