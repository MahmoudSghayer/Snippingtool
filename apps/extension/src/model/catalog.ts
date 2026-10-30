/*
 * catalog.ts — the choices the Snipe Targets form offers, exactly as the EA
 * web app's own search panel offers them.
 *
 * `main/adapter.ts` builds this inside the page in two layers: first from
 * the web app's public data files (`catalog-static.ts`, no login needed),
 * then, once the web app has started, list by list from the web app itself:
 *
 *   - each filter list (quality, rarity, position, chemistry style,
 *     country/region, league, and each league's clubs) comes from the web
 *     app's own `factories.DataProvider`, so the entries, their order and
 *     their labels are the ones EA shows;
 *   - each entry's picture comes from the web app's own
 *     `AssetLocationUtils.getFilterImage`, so it is the same flag, badge,
 *     logo, card or icon EA shows;
 *   - the player list is the web app's own `players.json`
 *     (`AssetLocationUtils.getPlayerSearchFileUri()`), with portraits from
 *     `AssetLocationUtils.getPortraitImageUri()`.
 *
 * Verified against the web app's code (FC 27, 2026-09-23); see
 * docs/06-extension.md. Background keeps the result in `storage.local`.
 */

export interface CatalogPlayer {
  /** EA's base player id (`databaseId`): what `maskedDefId` searches on. */
  id: number;
  name: string;
  rating: number | null;
}

/** One entry of one of EA's filter lists. */
export interface CatalogOption {
  /** EA's id for the entry (nation id, league id, rarity id, position id...). */
  id: number;
  /** The value EA's search criteria takes for it ("gold", "ST", "130"...). */
  value: string;
  /** EA's label, in the user's web-app language. */
  label: string;
  /** EA's picture for the entry. */
  img?: string;
  /** Rarities only: whether the design comes in bronze/silver/gold (EA
   * narrows the rarity list by quality with this). */
  levels?: boolean;
}

export interface Catalog {
  players: CatalogPlayer[];
  /** Portrait URL with `{id}` where the player's id goes. */
  portrait?: string;
  levels: CatalogOption[];
  rarities: CatalogOption[];
  positions: CatalogOption[];
  playStyles: CatalogOption[];
  nations: CatalogOption[];
  leagues: CatalogOption[];
  /** Clubs per league id, as EA's Club list shows them once a league is picked. */
  clubs: Record<string, CatalogOption[]>;
  capturedAt: number;
  /** What could not be loaded or built, shown on the page. */
  notes?: string[];
}

/** EA's position-group values (`ZONE_*_VALUE`): searched as `zone`, not `position`. */
export const POSITION_ZONES = new Set([130, 131, 132, 133]);

/** EA's quality value for special cards (`SearchLevel.SPECIAL`). */
export const SPECIAL_LEVEL = 'SP';

/** Highest rarity id EA treats as a plain design (`ItemRarity.LOCK`). */
export const RARITY_LOCK = 2;

const MAX_NAME = 80;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** `players.json`: `{ Players: [{ id, f, l, c?, r }], LegendsPlayers: [...] }`. */
export function parsePlayersFile(json: unknown): CatalogPlayer[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const lists = [root.Players, root.LegendsPlayers].filter(Array.isArray) as unknown[][];
  const seen = new Set<number>();
  const out: CatalogPlayer[] = [];
  for (const list of lists) {
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const r = p as Record<string, unknown>;
      const id = Number(r.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      const name = (str(r.c) || [str(r.f), str(r.l)].filter(Boolean).join(' ')).slice(0, MAX_NAME);
      if (!name) continue;
      const rating = Number(r.r);
      seen.add(id);
      out.push({
        id,
        name,
        rating: Number.isInteger(rating) && rating >= 0 && rating <= 99 ? rating : null,
      });
    }
  }
  return out;
}

/**
 * The rarities EA's list shows for a quality, the way the web app's
 * `getItemRarityDP` narrows them: Special shows the promo designs, any other
 * quality only the designs that come in bronze/silver/gold.
 */
export function raritiesForLevel(rarities: CatalogOption[], level: string | null): CatalogOption[] {
  if (!level) return rarities;
  return rarities.filter((r) => (level === SPECIAL_LEVEL ? r.id > RARITY_LOCK : r.levels === true));
}

export function portraitUrl(catalog: Catalog | null | undefined, id: number): string | null {
  return catalog?.portrait ? catalog.portrait.replace('{id}', String(id)) : null;
}

/** The next price up or down, in the steps EA's price fields use. */
export function priceStep(price: number, dir: 1 | -1): number {
  const at = dir === 1 ? price : price - 1;
  const step = at < 1_000 ? 50 : at < 10_000 ? 100 : at < 50_000 ? 250 : at < 100_000 ? 500 : 1_000;
  const next =
    dir === 1 ? Math.floor(price / step) * step + step : Math.ceil(price / step) * step - step;
  return Math.max(0, Math.min(15_000_000, next));
}

/** Case- and accent-insensitive form for matching what a user types. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The player list, indexed for the searches the page runs on every
 * keystroke and the Gallery list parser runs per line. Built once per list
 * (`playerIndex` memoises by the array: every producer makes a fresh one,
 * never edits one in place) — the 20k `fold`s it costs used to be paid on
 * every keystroke.
 *
 * `bigrams` maps every two-character slice of a folded name to the players
 * whose names hold it, so a substring search looks only at the names that
 * hold the query's first two characters — every substring of two or more
 * characters starts with one of its own bigrams, so nothing is missed.
 */
export interface PlayerIndex {
  players: readonly CatalogPlayer[];
  /** `fold(name)`, parallel to `players`. */
  folded: string[];
  byId: Map<number, CatalogPlayer>;
  /** Exact folded name → the players with it, in list order. */
  byFolded: Map<string, CatalogPlayer[]>;
  /** Bigram → indices into `players` holding it, ascending, each once. */
  bigrams: Map<string, number[]>;
}

const INDEXES = new WeakMap<readonly CatalogPlayer[], PlayerIndex>();

export function playerIndex(players: readonly CatalogPlayer[]): PlayerIndex {
  const had = INDEXES.get(players);
  if (had) return had;
  const folded = new Array<string>(players.length);
  const byId = new Map<number, CatalogPlayer>();
  const byFolded = new Map<string, CatalogPlayer[]>();
  const bigrams = new Map<string, number[]>();
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    const n = fold(p.name);
    folded[i] = n;
    byId.set(p.id, p);
    const same = byFolded.get(n);
    if (same) same.push(p);
    else byFolded.set(n, [p]);
    for (let j = 0; j + 1 < n.length; j++) {
      const key = n.slice(j, j + 2);
      const bucket = bigrams.get(key);
      if (!bucket) bigrams.set(key, [i]);
      else if (bucket[bucket.length - 1] !== i) bucket.push(i);
    }
  }
  const index: PlayerIndex = { players, folded, byId, byFolded, bigrams };
  INDEXES.set(players, index);
  return index;
}

interface Hit {
  p: CatalogPlayer;
  starts: boolean;
}

/** Word-start matches first, then the highest rated. */
const byRank = (a: Hit, b: Hit): number => Number(b.starts) - Number(a.starts) || (b.p.rating ?? 0) - (a.p.rating ?? 0);

/** Players whose name contains `query`, names starting with it first, then
 * highest rated — from the index: only the names that hold the query's first
 * bigram are looked at, and only the top `limit` are kept as they are found
 * (a later equal hit never passes an earlier one, so the order is the one a
 * stable sort of every hit gives). */
export function searchIndex(index: PlayerIndex, query: string, limit = 12): CatalogPlayer[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const candidates = index.bigrams.get(q.slice(0, 2));
  if (!candidates) return [];
  const top: Hit[] = [];
  for (const i of candidates) {
    const n = index.folded[i]!;
    const at = n.indexOf(q);
    if (at < 0) continue;
    const hit: Hit = { p: index.players[i]!, starts: at === 0 || n[at - 1] === ' ' };
    let pos = top.length;
    while (pos > 0 && byRank(hit, top[pos - 1]!) < 0) pos--;
    if (pos < limit) {
      top.splice(pos, 0, hit);
      if (top.length > limit) top.pop();
    }
  }
  return top.map((h) => h.p);
}

/** Players whose name contains `query`, names starting with it first, then
 * highest rated. */
export function searchPlayers(players: readonly CatalogPlayer[], query: string, limit = 12): CatalogPlayer[] {
  return searchIndex(playerIndex(players), query, limit);
}

/** The catalog's lists as maps, for the lookups the page makes on every
 * draw (a chosen entry's label, a player's name by id). Built once per
 * catalog. */
export interface CatalogLookups {
  players: PlayerIndex;
  /** Each list's entries by id. */
  byId: { rarities: Map<number, CatalogOption>; positions: Map<number, CatalogOption>; playStyles: Map<number, CatalogOption>; nations: Map<number, CatalogOption>; leagues: Map<number, CatalogOption> };
  /** Every club, whatever its league, by id. */
  clubsById: Map<number, CatalogOption>;
}

const LOOKUPS = new WeakMap<Catalog, CatalogLookups>();

export function catalogLookups(catalog: Catalog): CatalogLookups {
  const had = LOOKUPS.get(catalog);
  if (had) return had;
  const map = (list: CatalogOption[]): Map<number, CatalogOption> => new Map(list.map((o) => [o.id, o]));
  const clubsById = new Map<number, CatalogOption>();
  for (const clubs of Object.values(catalog.clubs)) for (const c of clubs) if (!clubsById.has(c.id)) clubsById.set(c.id, c);
  const lookups: CatalogLookups = {
    players: playerIndex(catalog.players),
    byId: { rarities: map(catalog.rarities), positions: map(catalog.positions), playStyles: map(catalog.playStyles), nations: map(catalog.nations), leagues: map(catalog.leagues) },
    clubsById,
  };
  LOOKUPS.set(catalog, lookups);
  return lookups;
}
