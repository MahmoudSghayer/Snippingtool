/*
 * catalog.ts — the player, club, league and nation lists the Snipe Targets
 * form searches, taken from the files the EA web app itself downloads for
 * its own search form. `main/adapter.ts` sees those responses go by and
 * hands them to the parsers here; background keeps the result in
 * `storage.local`, so it is available after every later reload.
 *
 * Using EA's own data means the ids a target stores are exactly the ids
 * EA's search takes (a player's base definition id, EA's club/league/nation
 * ids), with nothing to map.
 *
 * ASSUMED SHAPE (verify on day one, like `main/adapter.ts`):
 *   players.json — `{ Players: [{ id, f, l, c?, r }], LegendsPlayers: [...] }`
 *     under `.../fut/items/web/players.json`: first name, last name, common
 *     name, rating.
 *   the localisation file — a flat `{ key: text }` JSON under a `/loc/` path,
 *     with keys like `global.teamFull.<year>.team<id>`,
 *     `global.leagueFull.<year>.league<id>` and `search.nationName.nation<id>`.
 * A file that does not look like this parses to nothing: the form then asks
 * for a player id instead of offering names.
 */

export interface CatalogPlayer {
  /** EA's base definition id: what a player search is keyed on. */
  id: number;
  name: string;
  rating: number | null;
}

export interface CatalogEntry {
  id: number;
  name: string;
}

export interface CatalogNames {
  clubs: CatalogEntry[];
  leagues: CatalogEntry[];
  nations: CatalogEntry[];
}

export interface Catalog extends CatalogNames {
  players: CatalogPlayer[];
  capturedAt: number;
}

export const PLAYERS_FILE = /\/fut\/items\/web\/players\.json(?:[?#]|$)/i;
export const LOC_FILE = /\/loc\/[^/?#]+\.json(?:[?#]|$)/i;

/** Positions EA's search form offers, in its own order. */
export const POSITIONS = [
  'GK',
  'RB',
  'RWB',
  'CB',
  'LB',
  'LWB',
  'CDM',
  'CM',
  'CAM',
  'RM',
  'LM',
  'RW',
  'LW',
  'CF',
  'ST',
] as const;

export const QUALITIES = [
  { key: 'bronze', label: 'Bronze' },
  { key: 'silver', label: 'Silver' },
  { key: 'gold', label: 'Gold' },
  { key: 'special', label: 'Special' },
] as const;

const MAX_NAME = 80;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

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

const CLUB_KEY = /^global\.teamFull\.\d{4}\.team(\d+)$/;
const LEAGUE_KEY = /^global\.leagueFull\.\d{4}\.league(\d+)$/;
const NATION_KEY = /^search\.nationName\.nation(\d+)$/;

function byName(map: Map<number, string>): CatalogEntry[] {
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseLocFile(json: unknown): CatalogNames {
  const clubs = new Map<number, string>();
  const leagues = new Map<number, string>();
  const nations = new Map<number, string>();
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      const name = str(value).slice(0, MAX_NAME);
      if (!name) continue;
      let m = CLUB_KEY.exec(key);
      if (m) {
        clubs.set(Number(m[1]), name);
        continue;
      }
      m = LEAGUE_KEY.exec(key);
      if (m) {
        leagues.set(Number(m[1]), name);
        continue;
      }
      m = NATION_KEY.exec(key);
      if (m) nations.set(Number(m[1]), name);
    }
  }
  return { clubs: byName(clubs), leagues: byName(leagues), nations: byName(nations) };
}

/** Case- and accent-insensitive form for matching what a user types. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Players whose name contains `query`, names starting with it first, then
 * highest rated. */
export function searchPlayers(
  players: CatalogPlayer[],
  query: string,
  limit = 12,
): CatalogPlayer[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const hits: { p: CatalogPlayer; starts: boolean }[] = [];
  for (const p of players) {
    const n = fold(p.name);
    const i = n.indexOf(q);
    if (i < 0) continue;
    hits.push({ p, starts: i === 0 || n[i - 1] === ' ' });
  }
  hits.sort((a, b) => Number(b.starts) - Number(a.starts) || (b.p.rating ?? 0) - (a.p.rating ?? 0));
  return hits.slice(0, limit).map((h) => h.p);
}
