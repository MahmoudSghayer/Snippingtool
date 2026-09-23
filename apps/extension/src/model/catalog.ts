/*
 * catalog.ts — the choices the Snipe Targets form offers, exactly as the EA
 * web app's own search panel offers them.
 *
 * `main/adapter.ts` builds this inside the page once the web app has
 * started, by asking the web app itself:
 *
 *   - each filter list (quality, rarity, position, chemistry style,
 *     country/region, league, and each league's clubs) comes from the web
 *     app's own `UTDataProviderFactory`, so the entries, their order and
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
      out.push({ id, name, rating: Number.isInteger(rating) && rating >= 0 && rating <= 99 ? rating : null });
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
  const next = dir === 1 ? Math.floor(price / step) * step + step : Math.ceil(price / step) * step - step;
  return Math.max(0, Math.min(15_000_000, next));
}

/** Case- and accent-insensitive form for matching what a user types. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Players whose name contains `query`, names starting with it first, then
 * highest rated. */
export function searchPlayers(players: CatalogPlayer[], query: string, limit = 12): CatalogPlayer[] {
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
