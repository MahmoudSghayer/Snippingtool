/*
 * catalog-static.ts — builds the Snipe Targets lists straight from the EA
 * web app's public data files, the same files its own lists come from:
 *
 *   {root}config/companion/teamconfig.json   nations, leagues, clubs per league
 *   web-app/loc/<locale>.json                every name (in the user's language)
 *   {root}items/images/backgrounds/itemBGs/futcompitemraritytunables.json
 *                                            rarity designs (card art guid, levels)
 *
 * where {root} is `fut_resourceRoot + fut_resourceBase + fut_guid/fut_year/fut/`
 * (globals the web app's page sets). Images use the web app's own paths.
 *
 * `main/adapter.ts` prefers the web app's own `factories.DataProvider`
 * lists and falls back to these per list, so one list that fails to build
 * never blanks the rest. Everything here was checked against the FC 27 web
 * app's code and files (2026-09-23); orders mirror its `UTDataProviderFactory`.
 */
import type { CatalogOption } from './catalog.js';

export interface StaticSources {
  /** `.../content/<guid>/<year>/fut/` */
  root: string;
  /** `.../ea-sports-fc/ultimate-team/web-app/` */
  web: string;
  year: string;
  teamConfig: unknown;
  loc: Record<string, unknown>;
  rarityTunables: unknown;
}

export interface StaticLists {
  levels: CatalogOption[];
  rarities: CatalogOption[];
  positions: CatalogOption[];
  playStyles: CatalogOption[];
  nations: CatalogOption[];
  leagues: CatalogOption[];
  clubs: Record<string, CatalogOption[]>;
  portrait: string;
}

/** The web app's `TOP_NINE_NATIONS`, listed before all nations A-Z. */
export const TOP_NINE_NATIONS = [52, 54, 14, 18, 21, 34, 27, 38, 45];
/** League abbreviations the web app's `getLeagueDP` lists first, in order. */
const TOP_LEAGUES = [
  'ENG 1',
  'ENG 2',
  'ENG 3',
  'ENG 4',
  'FRA 1',
  'FRA 2',
  'ITA 1',
  'ITA 2',
  'GER 1',
  'GER 2',
  'GER 3',
  'ESP 1',
  'ESP 2',
];
const LAST_LEAGUES = ['AUT 1', 'CZE 1'];
/** The web app's `SEARCHABLE_POSITIONS` (PlayerPosition ids) and their names. */
const SEARCHABLE_POSITIONS: [number, string][] = [
  [0, 'GK'],
  [3, 'RB'],
  [5, 'CB'],
  [7, 'LB'],
  [10, 'CDM'],
  [12, 'RM'],
  [14, 'CM'],
  [16, 'LM'],
  [18, 'CAM'],
  [23, 'RW'],
  [25, 'ST'],
  [27, 'LW'],
];
const ZONES = [130, 131, 132];
const LEVELS: [string, number][] = [
  ['bronze', 1],
  ['silver', 2],
  ['gold', 3],
  ['SP', 4],
];

const text = (loc: Record<string, unknown>, key: string): string | null => {
  const v = loc[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

function yearBlock(teamConfig: unknown, year: string): Record<string, unknown> {
  const years = (teamConfig as { Years?: unknown })?.Years;
  if (!Array.isArray(years)) return {};
  return (
    ((years.find((y) => String((y as { Year?: unknown }).Year) === year) ?? years[0]) as Record<
      string,
      unknown
    >) ?? {}
  );
}

export function buildStaticLists(src: StaticSources): StaticLists {
  const { root, web, year, loc } = src;
  const mobile = `${root}items/images/mobile/`;
  const y = yearBlock(src.teamConfig, year);
  const byLabel = (a: CatalogOption, b: CatalogOption) => a.label.localeCompare(b.label);

  // Qualities: search.cardLevels.cardLevel1..4, EA's level badges.
  const levels = LEVELS.flatMap(([value, n], i) => {
    const label = text(loc, `search.cardLevels.cardLevel${n}`);
    return label
      ? [{ id: i, value, label, img: `${web}images/SearchFilters/level/${value}.png` }]
      : [];
  });

  // Rarities: Common and Rare first, then the searchable designs A-Z, with card art.
  const tunables = (src.rarityTunables as { rarities?: unknown[] })?.rarities ?? [];
  const designs = new Map<number, { guid?: string; levels?: boolean; hide?: boolean }>();
  for (const r of tunables) {
    const id = num((r as { id?: unknown }).id);
    if (id != null) designs.set(id, r as { guid?: string; levels?: boolean; hide?: boolean });
  }
  const rarityIds = [0, 1, ...[...designs.keys()].filter((id) => id > 1 && !designs.get(id)?.hide)];
  const rarities = [...new Set(rarityIds)]
    .flatMap((id) => {
      const label = text(loc, `item.raretype${id}`);
      if (!label) return [];
      const d = designs.get(id);
      const levelled = id <= 1 ? true : d?.levels === true;
      const folder = d?.guid ? `${d.guid}/` : 'large/';
      const img = `${root}items/images/backgrounds/itemBGs/${folder}cards_bg_e_1_${id}_${levelled ? 3 : 0}.png`;
      return [{ id, value: String(id), label, img, levels: levelled }];
    })
    .sort((a, b) =>
      a.id <= 1 && b.id > 1
        ? -1
        : b.id <= 1 && a.id > 1
          ? 1
          : a.id <= 1 && b.id <= 1
            ? a.id - b.id
            : byLabel(a, b),
    );

  // Positions: Defenders / Midfielders / Attackers, then each searchable position.
  const positions: CatalogOption[] = [
    ...ZONES.flatMap((z) => {
      const label = text(loc, `search.positions.zone${z}`);
      return label ? [{ id: z, value: String(z), label, img: `${mobile}positions/${z}.png` }] : [];
    }),
    ...SEARCHABLE_POSITIONS.map(([id, name]) => ({
      id,
      value: name,
      label: text(loc, `IWL_extendedPlayerInfo.positions.position${id}`) ?? name,
      img: `${mobile}positions/${id}.png`,
    })),
  ];

  // Chemistry styles 250 (Basic) .. 273 (GK Basic).
  const playStyles: CatalogOption[] = [];
  for (let id = 250; id <= 273; id++) {
    const label = text(loc, `IWL_playstyles.playstyle${id}`);
    if (label)
      playStyles.push({
        id,
        value: String(id),
        label,
        img: `${mobile}chemistrystyles/list/${id}.png`,
      });
  }

  // Nations: EA's top nine first, then every nation A-Z (as EA lists them).
  const nationIds = (Array.isArray(y.Nations) ? y.Nations : [])
    .map(num)
    .filter((n): n is number => n != null);
  const nation = (id: number): CatalogOption | null => {
    const label = text(loc, `search.nationName.nation${id}`);
    return label ? { id, value: String(id), label, img: `${mobile}flags/dark/${id}.png` } : null;
  };
  const allNations = nationIds
    .map(nation)
    .filter((n): n is CatalogOption => n != null)
    .sort(byLabel);
  const nations = [
    ...TOP_NINE_NATIONS.map(nation).filter((n): n is CatalogOption => n != null),
    ...allNations,
  ];

  // Leagues: EA's top leagues first, "Name (ABBR)".
  const leagueRows = (Array.isArray(y.Leagues) ? y.Leagues : [])
    .map((l) => num((l as { LeagueId?: unknown }).LeagueId))
    .filter((n): n is number => n != null)
    .flatMap((id) => {
      const name = text(loc, `global.leagueFull.${year}.league${id}`);
      if (!name) return [];
      const abbr = text(loc, `global.leagueabbr5.${year}.league${id}`) ?? '';
      return [{ id, name, abbr }];
    });
  leagueRows.sort((a, b) => {
    const at = TOP_LEAGUES.indexOf(a.abbr);
    const bt = TOP_LEAGUES.indexOf(b.abbr);
    if (at >= 0 !== bt >= 0) return at >= 0 ? -1 : 1;
    if (at >= 0) return at - bt;
    const al = LAST_LEAGUES.indexOf(a.abbr);
    const bl = LAST_LEAGUES.indexOf(b.abbr);
    if (al >= 0 !== bl >= 0) return al >= 0 ? 1 : -1;
    if (al >= 0) return al - bl;
    return a.name.localeCompare(b.name);
  });
  const leagues = leagueRows.map((l) => ({
    id: l.id,
    value: String(l.id),
    label: l.abbr ? `${l.name} (${l.abbr})` : l.name,
    img: `${mobile}leagues/dark/${l.id}.png`,
  }));

  // Clubs per league, A-Z.
  const clubs: Record<string, CatalogOption[]> = {};
  const teamRows = [
    ...(Array.isArray(y.Teams) ? y.Teams : []),
    ...(Array.isArray(y.ClubItemTeams) ? y.ClubItemTeams : []),
  ];
  const seen = new Set<number>();
  for (const t of teamRows) {
    const id = num((t as { TeamId?: unknown }).TeamId);
    const league = num((t as { LeagueId?: unknown }).LeagueId);
    if (id == null || league == null || seen.has(id)) continue;
    const label = text(loc, `global.teamabbr15.${year}.team${id}`);
    if (!label) continue;
    seen.add(id);
    (clubs[String(league)] ??= []).push({
      id,
      value: String(id),
      label,
      img: `${mobile}clubs/dark/${id}.png`,
    });
  }
  for (const list of Object.values(clubs)) list.sort(byLabel);

  return {
    levels,
    rarities,
    positions,
    playStyles,
    nations,
    leagues,
    clubs,
    portrait: `${mobile}portraits/{id}.png`,
  };
}
