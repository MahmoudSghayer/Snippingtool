/*
 * catalog-builder.ts — MAIN world: builds the Sniping Bot's Snipe Targets
 * choices (model/catalog.ts) with the EA web app's own lists and images.
 * `main/adapter.ts` owns when it runs and how the result leaves the page:
 * only in automation builds, and only as a `catalog` message signed under
 * the act-channel nonce (lib/act-auth.ts), which content verifies and
 * validates before anything reads it.
 *
 * Read-only towards EA: it reads the web app's public data files (with the
 * page's own, captured `fetch`) and calls its list factories, the same ones
 * its search panel uses. Nothing here sends anything to EA's market.
 *
 * Built in two layers so the form never shows empty lists:
 *   1. from the web app's public data files (model/catalog-static.ts), as
 *      soon as the page has set its `fut_*` globals — no login needed;
 *   2. then, once the web app has started, each list is replaced by the web
 *      app's own (`factories.DataProvider`, the instance its search panel
 *      uses) when that list builds cleanly. Each list on its own: one that
 *      fails keeps its layer-1 version.
 * Problems are kept in `notes` and shown on the page, not swallowed.
 *
 * Its inputs are pinned, because this runs in the MAIN world page scripts
 * share (the signed `catalog` message stops a page script forging the
 * message, not feeding the builder):
 *   - the `fut_*` globals it reads are captured when the page first sets
 *     them (`capturePageGlobals`, installed at document_start with the
 *     adapter), so a page script that rewrites `fut_resourceRoot` later
 *     cannot repoint the data files;
 *   - it fetches only https URLs on EA hosts (`isEaAssetUrl`: ea.com,
 *     ea2.com, easports.com), whatever a global or an EA helper returns;
 *   - it keeps only images on those hosts, and content validates the whole
 *     catalog against the strict `adapterCatalogSchema` (which applies the
 *     same host rule) before anything reads it.
 * What it cannot pin: a page script that hooks EA's own list functions
 * (`factories.DataProvider`) can still skew names in the lists; every
 * filter it produces is still just a search the user reviews.
 */
import { isEaAssetUrl } from '@sl/shared/adapter-channel.js';

import { buildStaticLists } from '../model/catalog-static.js';
import { POSITION_ZONES, parsePlayersFile, type Catalog, type CatalogOption } from '../model/catalog.js';

/** Fetches and parses one of the web app's JSON files. */
export type GetJson = (url: string) => Promise<unknown>;

interface EaDataEntry {
  id: number;
  value: unknown;
  label: string;
}

interface EaCatalogGlobals {
  repositories?: {
    TeamConfig?: { getNations?: () => unknown[] };
    Rarity?: { getRarity?: (id: number) => { levels?: boolean } | undefined };
  };
  AssetLocationUtils?: {
    FILTER: Record<string, string>;
    getFilterImage(filter: string, value: unknown, extra?: unknown): string;
    getPlayerSearchFileUri(): string;
    getPortraitImageUri(id: number): string;
  };
  ItemType?: { PLAYER: string };
  SearchLevel?: { ANY: string };
}

const ea = window as unknown as EaCatalogGlobals;

interface PageGlobals {
  factories?: { DataProvider?: Record<string, (...a: unknown[]) => EaDataEntry[]> };
}

/** The page globals the data files are found with. */
export const FUT_GLOBALS = ['fut_resourceRoot', 'fut_resourceBase', 'fut_guid', 'fut_year'] as const;
export type FutGlobals = Partial<Record<(typeof FUT_GLOBALS)[number], string>>;

/**
 * Pins the `fut_*` globals at the first string value the page gives each
 * (EA's own bootstrap sets them; the adapter installs this at
 * document_start, before any page script). Returns the captured values,
 * filled in as the page sets them; later writes still reach the page's own
 * view of the global, but never this one. A global already set when this
 * runs is captured as it is.
 */
export function capturePageGlobals(win: object = window): FutGlobals {
  const captured: FutGlobals = {};
  for (const name of FUT_GLOBALS) {
    const desc = Object.getOwnPropertyDescriptor(win, name);
    if (desc && 'value' in desc) {
      if (typeof desc.value === 'string') captured[name] = desc.value;
      continue;
    }
    if (desc && !desc.configurable) continue;
    let current: unknown = undefined;
    try {
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value: unknown) => {
          current = value;
          if (captured[name] === undefined && typeof value === 'string') captured[name] = value;
        },
      });
    } catch {
      /* the page made it unconfigurable first: leave it uncaptured */
    }
  }
  return captured;
}

/** The page's own URL, captured at load: relative URLs from EA's helpers
 * resolve against it, not `document.baseURI` (a page script can add a
 * <base>). */
const PAGE_URL = window.location.href;

function absolute(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, PAGE_URL).toString();
  } catch {
    return undefined;
  }
}

/** `url` made absolute, if it is an https URL on an EA host; else undefined. */
function eaUrl(url: string | undefined | null): string | undefined {
  const abs = absolute(url);
  return abs && isEaAssetUrl(abs) ? abs : undefined;
}

/** Only fetches https URLs on EA hosts (`isEaAssetUrl`); anything else is
 * refused before a request is made. */
function pinnedGetJson(getJson: GetJson): GetJson {
  return (url) => {
    const target = eaUrl(url);
    if (!target) return Promise.reject(new Error('refused: not an https URL on an EA host'));
    return getJson(target);
  };
}

/** Drops every image (and the portrait template) that is not on an EA host,
 * so one bad URL loses its image, not the whole catalog (which content's
 * strict schema would refuse). */
function keepEaImages(c: Catalog): void {
  const clean = (options: CatalogOption[]) => {
    for (const o of options) if (o.img !== undefined && !isEaAssetUrl(o.img)) delete o.img;
  };
  for (const list of [c.levels, c.rarities, c.positions, c.playStyles, c.nations, c.leagues]) clean(list);
  for (const clubs of Object.values(c.clubs)) clean(clubs);
  if (c.portrait !== undefined && !isEaAssetUrl(c.portrait)) delete c.portrait;
}

/** The locale file the web app itself loaded, else en-US. */
function webAppLocale(): string {
  try {
    for (const e of performance.getEntriesByType('resource')) {
      const m = /\/web-app\/loc\/([A-Za-z]{2}[-_][A-Za-z]{2})\.json/.exec(e.name);
      if (m) return m[1]!;
    }
  } catch {
    /* fall through */
  }
  return 'en-US';
}

async function buildStaticCatalog(getJson: GetJson, g: FutGlobals): Promise<Catalog | null> {
  if (!g.fut_resourceRoot || !g.fut_resourceBase || !g.fut_guid || !g.fut_year) return null;
  const base = `${g.fut_resourceRoot}${g.fut_resourceBase}`;
  const root = `${base}${g.fut_guid}/${g.fut_year}/fut/`;
  const web = base.replace(/content\/?$/, '');
  const notes: string[] = [];
  const load = async (url: string): Promise<unknown> => {
    try {
      return await getJson(url);
    } catch (err) {
      notes.push(
        `could not load ${url.split('/').slice(-2).join('/')}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  const locale = webAppLocale();
  const [teamConfig, locFile, rarityTunables, playersFile] = await Promise.all([
    load(`${root}config/companion/teamconfig.json`),
    load(`${web}loc/${locale}.json`),
    load(`${root}items/images/backgrounds/itemBGs/futcompitemraritytunables.json`),
    load(`${root}items/web/players.json`),
  ]);
  const lists = buildStaticLists({
    root,
    web,
    year: g.fut_year,
    teamConfig,
    loc: locFile && typeof locFile === 'object' ? (locFile as Record<string, unknown>) : {},
    rarityTunables,
  });
  return { players: parsePlayersFile(playersFile), ...lists, capturedAt: Date.now(), notes };
}

/** When the page has no `fut_*` globals to find the data files with: an
 * empty catalog for the web app's own lists to fill, once the web app has
 * started (players from its own player-list path). Null until then. */
async function emptyLiveCatalog(getJson: GetJson): Promise<Catalog | null> {
  const A = ea.AssetLocationUtils;
  if (!(window as unknown as PageGlobals).factories?.DataProvider || !A) return null;
  let players: Catalog['players'] = [];
  const notes: string[] = [];
  try {
    players = parsePlayersFile(await getJson(A.getPlayerSearchFileUri()));
  } catch (err) {
    notes.push(
      `could not load the player list: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    players,
    levels: [],
    rarities: [],
    positions: [],
    playStyles: [],
    nations: [],
    leagues: [],
    clubs: {},
    capturedAt: Date.now(),
    notes,
  };
}

/** Replaces each list with the web app's own, where that list builds cleanly. */
function applyLiveLists(c: Catalog): boolean {
  const dp = (window as unknown as PageGlobals).factories?.DataProvider;
  const A = ea.AssetLocationUtils;
  if (!dp || !A || !ea.repositories?.TeamConfig?.getNations?.().length) return false;
  const F = A.FILTER;
  const notes = c.notes ?? (c.notes = []);
  const image = (filter: string | undefined, value: unknown): string | undefined => {
    try {
      return filter ? eaUrl(A.getFilterImage(filter, value)) : undefined;
    } catch {
      return undefined;
    }
  };
  const opts = (
    dp: EaDataEntry[] | undefined,
    filter: string | undefined,
    byValue = false,
  ): CatalogOption[] =>
    (dp ?? [])
      .filter(
        (e) => e.id !== -1 && e.value !== 'any' && e.value !== '-1' && String(e.label ?? '').trim(),
      )
      .map((e) => ({
        id: Number(e.id),
        value: String(e.value),
        label: String(e.label).trim().slice(0, 120),
        img: image(filter, byValue ? e.value : e.id),
      }));
  const live = (name: string, build: () => CatalogOption[]): CatalogOption[] | null => {
    try {
      const list = build();
      return list.length > 0 ? list : null;
    } catch (err) {
      notes.push(`EA ${name} list: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const call = (m: string, ...args: unknown[]): EaDataEntry[] => {
    const fn = dp[m];
    if (typeof fn !== 'function') throw new Error(`factories.DataProvider.${m} is missing`);
    return fn.apply(dp, args);
  };

  c.levels = live('quality', () => opts(call('getRareItemLevelDP'), F.LEVEL, true)) ?? c.levels;
  c.rarities =
    live('rarity', () =>
      opts(
        call('getItemRarityDP', {
          itemSubTypes: [],
          itemTypes: [ea.ItemType?.PLAYER ?? 'player'],
          quality: ea.SearchLevel?.ANY ?? 'any',
          tradableOnly: true,
        }),
        F.RARITY,
      ).map((r) => ({
        ...r,
        levels:
          ea.repositories?.Rarity?.getRarity?.(r.id)?.levels === true ||
          c.rarities.find((x) => x.id === r.id)?.levels === true,
      })),
    ) ?? c.rarities;
  c.positions =
    live('position', () =>
      opts(call('getPlayerPositionDP', false), F.POSITION).map((p) =>
        POSITION_ZONES.has(p.id) ? { ...p, value: String(p.id) } : p,
      ),
    ) ?? c.positions;
  c.playStyles =
    live('chemistry style', () => opts(call('getPlayStyleDP'), F.PLAYSTYLE)) ?? c.playStyles;
  c.nations = live('country', () => opts(call('getNationDP'), F.NATION)) ?? c.nations;
  const leagues = live('league', () => opts(call('getLeagueDP', true), F.LEAGUE));
  if (leagues) {
    c.leagues = leagues;
    for (const l of leagues) {
      const clubs = live('club', () => opts(call('getTeamDP', l.id), F.CLUB));
      if (clubs) c.clubs[String(l.id)] = clubs;
    }
  }
  try {
    const p = eaUrl(A.getPortraitImageUri(987654321));
    if (p) c.portrait = p.replace('987654321', '{id}');
  } catch {
    /* keep the static template */
  }
  c.capturedAt = Date.now();
  return true;
}

/** The schema's bounds (@sl/shared `extBackgroundCatalogSavePayloadSchema`),
 * so a long run of failing lists cannot make the whole catalog invalid. */
const MAX_NOTES = 50;
const MAX_NOTE_LENGTH = 500;

export interface CatalogBuilder {
  /** Builds what it can now. Resolves with the catalog so far (null when
   * nothing can be built yet), and whether EA's own lists are in it. */
  refresh(): Promise<{ catalog: Catalog | null; complete: boolean }>;
}

/** `globals` defaults to capturing them now: call this at document_start
 * (main/adapter.ts does, at load). */
export function createCatalogBuilder(
  fetchJson: GetJson,
  globals: FutGlobals = capturePageGlobals(),
): CatalogBuilder {
  const getJson = pinnedGetJson(fetchJson);
  let catalog: Catalog | null = null;
  let liveApplied = false;
  let building: Promise<{ catalog: Catalog | null; complete: boolean }> | null = null;

  async function build(): Promise<{ catalog: Catalog | null; complete: boolean }> {
    try {
      if (!catalog) catalog = (await buildStaticCatalog(getJson, globals)) ?? (await emptyLiveCatalog(getJson));
      if (catalog && !liveApplied) liveApplied = applyLiveLists(catalog);
    } catch (err) {
      if (catalog) (catalog.notes ??= []).push(String(err));
    }
    if (catalog) keepEaImages(catalog);
    if (catalog?.notes) {
      catalog.notes = catalog.notes.slice(-MAX_NOTES).map((n) => n.slice(0, MAX_NOTE_LENGTH));
    }
    return { catalog, complete: catalog !== null && liveApplied };
  }

  return {
    refresh() {
      building ??= build().finally(() => {
        building = null;
      });
      return building;
    },
  };
}
