// Synthetic, deterministic datasets at the sizes the real ones reach: EA's
// player list (15-20k players; the schema allows 100k), a full Gallery list
// (300 cards over 20 Sets) and fut.gg's hub (hundreds of Sets, five grades
// each). Names mix accents and shared surnames so the search sees the same
// shapes it does on real data (many "de", "an", "ma" bigrams; namesakes).
import type { Catalog, CatalogOption, CatalogPlayer } from '../../src/model/catalog.js';
import type { FutggLineup, FutggSetSummary, GalleryCard, GalleryState } from '@sl/shared';

const FIRST = ['José', 'João', 'Müller', 'Kylian', 'Erling', 'Vinícius', 'Mohamed', 'Rodrigo', 'Ángel', 'Bukayo', 'Jude', 'Pedri', 'Gavi', 'Declan', 'Martin', 'Kevin', 'Harry', 'Son', 'Luka', 'Lionel', 'Cristiano', 'Antoine', 'Ousmane', 'Rafael', 'Nicolò', 'Federico', 'Dušan', 'Nikola', 'Çağlar', 'Łukasz'];
const LAST = ['Silva', 'Santos', 'Rodríguez', 'Fernández', 'García', 'Martínez', 'Müller', 'Schmidt', 'Rossi', 'Bianchi', 'Hernández', 'López', 'González', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Díaz', 'Mbappé', 'Haaland', 'Salah', 'Bellingham', 'Saka', 'Kane', 'Modrić', 'Messi', 'Ronaldo', 'Griezmann', 'Dembélé', 'Leão', 'Barella', 'Chiesa', 'Vlahović', 'Jović', 'Söyüncü', 'Fabiański', 'Oyarzabal', 'Nkunku', 'Ekitiké', 'Wirtz'];

/** A small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePlayers(n: number, seed = 1): CatalogPlayer[] {
  const rnd = prng(seed);
  const out: CatalogPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const f = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const l = LAST[Math.floor(rnd() * LAST.length)]!;
    // Some two-surname names, some mononyms, a few with no rating.
    const name = rnd() < 0.15 ? `${f} ${l} ${LAST[Math.floor(rnd() * LAST.length)]}` : rnd() < 0.05 ? l : `${f} ${l}`;
    out.push({ id: 100_000 + i, name, rating: rnd() < 0.02 ? null : 45 + Math.floor(rnd() * 50) });
  }
  return out;
}

function options(n: number, prefix: string, withImg = true): CatalogOption[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, value: String(i + 1), label: `${prefix} ${i + 1}`, ...(withImg ? { img: `https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/images/${prefix}/${i + 1}.png` } : {}) }));
}

export function makeCatalog(players: number, seed = 1): Catalog {
  const leagues = options(40, 'League');
  const clubs: Record<string, CatalogOption[]> = {};
  for (const l of leagues) clubs[String(l.id)] = options(20, `Club ${l.id}`);
  return {
    players: makePlayers(players, seed),
    portrait: 'https://ratings-images-prod.pulse.ea.com/FC27/portraits/{id}.png',
    levels: options(4, 'Level'),
    rarities: options(80, 'Rarity').map((r) => ({ ...r, levels: r.id < 10 })),
    positions: options(20, 'Position'),
    playStyles: options(25, 'Style'),
    nations: options(200, 'Nation'),
    leagues,
    clubs,
    capturedAt: 1_700_000_000_000 + seed,
  };
}

/** A Gallery list of `cards` fut.gg cards over `sets` Sets, with a spread of
 * statuses like a half-worked list. */
export function makeGallery(cards: number, sets: number, seed = 7): GalleryState {
  const rnd = prng(seed);
  const statuses: GalleryCard['status'][] = ['todo', 'todo', 'todo', 'bought', 'club', 'listed', 'owned', 'skipped', 'sbc'];
  const list: GalleryCard[] = [];
  const setDefs: NonNullable<GalleryState['sets']> = [];
  for (let s = 0; s < sets; s++) {
    setDefs.push({ id: 500 + s, name: `Set ${s}`, path: `cat/set-${s}`, grade: 'S', threshold: 900, score: 950, tokens: 28, cost: 50_000, tiers: [{ grade: 'A', threshold: 700 }, { grade: 'S', threshold: 900 }] });
  }
  for (let i = 0; i < cards; i++) {
    const setIdx = i % sets;
    const playerId = 100_000 + i;
    const rating = 70 + (i % 25);
    list.push({
      key: `${playerId}:${rating}:x`,
      name: `Player ${i}`,
      rating,
      playerId,
      resourceId: 50_000_000 + i,
      exact: true,
      set: `Set ${setIdx}`,
      setIds: [500 + setIdx, ...(rnd() < 0.1 ? [500 + ((setIdx + 1) % sets)] : [])],
      score: 40 + (i % 60),
      guide: 1_000 + (i % 50) * 100,
      status: statuses[Math.floor(rnd() * statuses.length)]!,
    });
  }
  const completed = Array.from({ length: Math.floor(sets / 4) }, (_, i) => 500 + sets + i);
  return { budget: 1_000_000, spent: 123_456, cards: list, sets: setDefs, completed, completedAt: Object.fromEntries(completed.map((id) => [String(id), 1_700_000_000_000])), completedGrade: Object.fromEntries(completed.map((id) => [String(id), 'A' as const])) };
}

/** fut.gg Set summaries as `handleFutggSets` returns them. */
export function makeFutggSets(n: number): FutggSetSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    name: `Club ${i} FC`,
    category: `League ${i % 12}`,
    path: `league-${i % 12}/club-${i}`,
    requiredCards: 15,
    tiers: (['D', 'C', 'B', 'A', 'S'] as const).map((grade, g) => ({ grade, threshold: 300 + g * 150, tokens: 8 + g * 5, cost: 5_000 + g * 9_000 + i * 10, peak: 3_000, score: 320 + g * 150, cards: 15, sbc: grade === 'S' && i % 3 === 0 ? 1 : 0 })),
  }));
}

/** fut.gg's hub JSON, at `n` Sets with five priced tiers of 15 cards each. */
export function makeHubJson(n: number): unknown {
  const categories = Array.from({ length: 12 }, (_, c) => ({ id: c + 1, name: `League ${c}`, slug: `league-${c}`, sets: [] as unknown[] }));
  const sets: unknown[] = [];
  for (let i = 0; i < n; i++) {
    categories[i % 12]!.sets.push({ id: 1000 + i, categoryId: (i % 12) + 1, name: `Club ${i} FC`, slug: `club-${i}`, requiredCards: 15, grades: [], totalTokens: 48 });
    sets.push({
      setId: 1000 + i,
      grade: 'S',
      costTiers: (['D', 'C', 'B', 'A', 'S'] as const).map((grade, g) => ({
        grade,
        threshold: 300 + g * 150,
        tokens: 8 + g * 5,
        cost: 5_000 + g * 9_000,
        peakPrice: 3_000,
        totalScore: 320 + g * 150,
        items: Array.from({ length: 15 }, (_, k) => ({ eaId: 10_000_000 + i * 100 + k, price: 300 + k * 50 })),
      })),
    });
  }
  return { data: { schemaVersion: 1, game: 'fc27', categories, sets } };
}

export function makePoolJson(setIndex: number, size = 120): unknown {
  return {
    data: {
      setId: 1000 + setIndex,
      items: Array.from({ length: size }, (_, k) => ({
        eaId: 10_000_000 + setIndex * 100 + k,
        playerEaId: 200_000 + setIndex * 100 + k,
        score: 20 + ((k * 7) % 90),
        overall: 60 + (k % 30),
        rarityEaId: k % 5,
        rarityName: ['Rare', 'Common', 'TOTW', 'Hero', 'Icon'][k % 5],
        holographic: k % 9 === 0,
        commonName: `Pool ${setIndex} Player ${k}`,
        nationEaId: 1 + (k % 50),
        clubEaId: 1 + (k % 40),
        leagueEaId: 1 + (k % 12),
        positions: ['CM'],
        weakFoot: 3,
        skillMoves: 3,
      })),
    },
  };
}

export function makeTagsJson(): unknown {
  return {
    data: {
      tags: [
        { id: 8, name: 'Same Club', tiers: [{ minItems: 5, bonus: 1 }, { minItems: 10, bonus: 2 }], rules: [{ target: 'ATTRIBUTE', type: 'MAX_COUNT_ALL_SAME', attribute: 'CLUB', values: ['0'] }] },
        { id: 7, name: 'Golden', tiers: [{ minItems: 5, bonus: 1 }], rules: [{ target: 'ATTRIBUTE', type: 'COUNT', attribute: 'LEVEL', values: ['gold'] }] },
      ],
    },
  };
}

/** A lineup as `handleFutggLineup` returns one, for page-level benches. */
export function makeLineup(set: FutggSetSummary, grade: FutggLineup['grade'], setIndex: number): FutggLineup {
  const cards = Array.from({ length: 15 }, (_, k) => ({
    resourceId: 10_000_000 + setIndex * 100 + k,
    playerId: 200_000 + setIndex * 100 + k,
    name: `Pool ${setIndex} Player ${k}`,
    rating: 60 + (k % 30),
    rarity: k % 5,
    version: 'Rare',
    holographic: false,
    score: 20 + ((k * 7) % 90),
    price: 300 + k * 50,
    club: 1 + (k % 40),
    nation: 1 + (k % 50),
    league: 1 + (k % 12),
  }));
  return { set, grade, cards, missing: 0 };
}
