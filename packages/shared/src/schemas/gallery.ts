import { z } from 'zod';

/**
 * Nova AI's Gallery mode (apps/extension `engine/gallery.ts`): the trader's
 * list of cards to collect for FC's Gallery Sets, each card's progress, and
 * the coin budget for the list. EA's web app has no Gallery, so Nova cannot
 * read a Set's grade: it works from this list, buys each card, sends it to
 * the club (so the Set counts it) and lists it again at once.
 *
 * The list comes from the trader's own lines, or from fut.gg: a Set's
 * cheapest lineup for its best grade (fut.gg's Gallery solver), each card
 * named by its exact id (`exact`), with the Set itself in `sets`.
 *
 * Kept in the browser's own storage (`bot.galleryGet` / `bot.gallerySet`),
 * like Bid mode's settings: nothing here goes to the server.
 */
export const GALLERY_LIMITS = {
  /** Cards on one list. */
  cards: 300,
  /** The list's coin budget. */
  budget: { min: 0, max: 100_000_000 },
  /** A card's rating, as the trader types it. */
  rating: { min: 40, max: 99 },
  nameLength: 60,
  setLength: 60,
  versionLength: 40,
  noteLength: 200,
  /** fut.gg Sets on one list. */
  sets: 40,
  /** fut.gg Sets marked completed. */
  completed: 500,
} as const;

/**
 * A card's progress:
 * - `todo`: still to buy.
 * - `bought`: bought, not in the club yet (on this page load Nova sends it
 *   there next; bought on an earlier one, the trader finishes it by hand).
 * - `club`: in the club, not listed yet.
 * - `listed`: back on the transfer market.
 * - `skipped`: left out, with the reason in `note` (no player found, none
 *   listed, the price too far over the market, the budget).
 * - `owned`: already in the trader's club (EA's club said so): it counts
 *   for the Set as it is, so nothing is bought.
 */
export const GALLERY_CARD_STATUSES = [
  'todo',
  'bought',
  'club',
  'listed',
  'skipped',
  'owned',
] as const;
export type GalleryCardStatus = (typeof GALLERY_CARD_STATUSES)[number];

const coins = z.number().int().min(0).max(15_000_000);

export const galleryCardSchema = z
  .object({
    /** Unique on the list: the player, the rating and the version. */
    key: z.string().min(1).max(80),
    /** The player's name as EA's player list has it. */
    name: z.string().min(1).max(GALLERY_LIMITS.nameLength),
    rating: z.number().int().min(GALLERY_LIMITS.rating.min).max(GALLERY_LIMITS.rating.max),
    /** EA's base player id (what a search asks for, `maskedDefId`). */
    playerId: z.number().int().positive(),
    /** The card's own id (its version), once known: equal to `playerId` for
     * a player's base card, else learned from the first search. */
    resourceId: z.number().int().positive().optional(),
    /** The version the trader asked for, as EA's rarity id and its name in
     * EA's Rarity list ("Signature"): only that version is bought. Absent:
     * any version at the rating (the cheapest). */
    rarity: z.number().int().min(0).max(1_000).optional(),
    version: z.string().min(1).max(GALLERY_LIMITS.versionLength).optional(),
    /** The Set heading the card was listed under, if any. */
    set: z.string().max(GALLERY_LIMITS.setLength).optional(),
    /** Only this exact card (`resourceId`) is bought, never another version
     * of the player at the rating: a fut.gg lineup card, whose Gallery
     * score is that card's own (a holographic copy shares the rating and
     * the rarity, and scores more). */
    exact: z.literal(true).optional(),
    /** The fut.gg Sets (their ids) whose lineup holds the card: one card
     * counts for several Sets. */
    setIds: z.array(z.number().int().positive()).max(GALLERY_LIMITS.sets).optional(),
    /** fut.gg's Gallery score for the card. */
    score: z.number().int().min(0).max(10_000_000).optional(),
    /** fut.gg's price for the card when the Set was loaded: the market price
     * when FUTBIN and Nova have none. */
    guide: coins.optional(),
    status: z.enum(GALLERY_CARD_STATUSES),
    /** What it was bought for. */
    price: coins.optional(),
    /** The market price it was judged by (FUTBIN's, else Nova's). */
    market: coins.optional(),
    /** The buy-now price it was listed at. */
    listPrice: coins.optional(),
    /** Why it was skipped, or what went wrong after the buy. */
    note: z.string().max(GALLERY_LIMITS.noteLength).optional(),
    /** The trade it was bought under, while its way to the club and the
     * market is not finished: a later Start on the same page load picks it
     * up again. */
    tradeId: z.string().min(1).max(40).optional(),
  })
  .strict();
export type GalleryCard = z.infer<typeof galleryCardSchema>;

export const GALLERY_GRADES = ['D', 'C', 'B', 'A', 'S'] as const;
export type GalleryGrade = (typeof GALLERY_GRADES)[number];

/** A fut.gg Set on the list: the grade its lineup is for, and what fut.gg
 * says that grade needs, gives and costs. */
export const gallerySetSchema = z
  .object({
    /** fut.gg's id for the Set. */
    id: z.number().int().positive(),
    name: z.string().min(1).max(GALLERY_LIMITS.setLength),
    /** The Set's page on fut.gg, under /fut-gallery/ ("laliga/malaga-cf"). */
    path: z
      .string()
      .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)
      .max(120),
    grade: z.enum(GALLERY_GRADES),
    /** The score the grade needs. */
    threshold: z.number().int().min(0).max(100_000_000),
    /** The lineup's score with every card, bonus tags included. */
    score: z.number().int().min(0).max(100_000_000),
    /** Gallery Tokens the Set gives up to the grade. */
    tokens: z.number().int().min(0).max(10_000),
    /** fut.gg's price for the whole lineup when it was loaded. */
    cost: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type GallerySet = z.infer<typeof gallerySetSchema>;

export const galleryStateSchema = z
  .object({
    cards: z.array(galleryCardSchema).max(GALLERY_LIMITS.cards),
    /** The fut.gg Sets the list's `exact` cards came from. */
    sets: z.array(gallerySetSchema).max(GALLERY_LIMITS.sets).optional(),
    /** fut.gg Sets (their ids) the trader completed: never offered again,
     * and their cards still to buy are left alone. Marked when all of a
     * Set's cards are collected, or by hand. */
    completed: z.array(z.number().int().positive()).max(GALLERY_LIMITS.completed).optional(),
    /** The most the list may spend on buys (0: nothing is bought). */
    budget: z.number().int().min(GALLERY_LIMITS.budget.min).max(GALLERY_LIMITS.budget.max),
    /** Coins spent on the list's buys so far. */
    spent: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type GalleryState = z.infer<typeof galleryStateSchema>;

export const EMPTY_GALLERY: GalleryState = { cards: [], budget: 100_000, spent: 0 };

/**
 * fut.gg's Gallery, as the Nova AI page shows it (background
 * `gallery.futggSets`): each Set with what each grade needs, gives and
 * costs, from fut.gg's own solver (the cheapest lineup per grade). Read from
 * fut.gg's public JSON, which can change at any time: anything that does not
 * read like this is left out.
 */
export const futggTierSchema = z
  .object({
    grade: z.enum(GALLERY_GRADES),
    threshold: z.number().int().min(0).max(100_000_000),
    tokens: z.number().int().min(0).max(10_000),
    /** The cheapest lineup's price in all, and its dearest card (what the
     * trader needs in hand when each card is sold before the next buy). */
    cost: z.number().int().min(0).max(1_000_000_000),
    peak: z.number().int().min(0).max(15_000_000),
    /** The lineup's score, and how many cards it buys. */
    score: z.number().int().min(0).max(100_000_000),
    cards: z.number().int().min(0).max(100),
  })
  .strict();
export type FutggTier = z.infer<typeof futggTierSchema>;

export const futggSetSummarySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(GALLERY_LIMITS.setLength),
    category: z.string().max(80),
    path: z
      .string()
      .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)
      .max(120),
    requiredCards: z.number().int().min(0).max(100),
    /** Each grade the Set can reach, D first; the last is its best. */
    tiers: z.array(futggTierSchema).max(GALLERY_GRADES.length),
  })
  .strict();
export type FutggSetSummary = z.infer<typeof futggSetSummarySchema>;

/** One card of a fut.gg lineup (background `gallery.futggLineup`). */
export const futggCardSchema = z
  .object({
    /** EA's id for the card (its version), and for the player. */
    resourceId: z.number().int().positive(),
    playerId: z.number().int().positive(),
    name: z.string().min(1).max(GALLERY_LIMITS.nameLength),
    rating: z.number().int().min(GALLERY_LIMITS.rating.min).max(GALLERY_LIMITS.rating.max),
    /** EA's rarity id and fut.gg's name for it. */
    rarity: z.number().int().min(0).max(1_000),
    version: z.string().max(GALLERY_LIMITS.versionLength),
    holographic: z.boolean(),
    score: z.number().int().min(0).max(10_000_000),
    /** fut.gg's price (0 on a card of the Set's card list that is not in
     * the lineup). */
    price: coins,
    /** What the Set's bonus tags look at (absent: not known). */
    nation: z.number().int().min(0).optional(),
    club: z.number().int().min(0).optional(),
    league: z.number().int().min(0).optional(),
    positions: z.array(z.string().max(4)).max(12).optional(),
    weakFoot: z.number().int().min(0).max(5).optional(),
    skillMoves: z.number().int().min(0).max(5).optional(),
  })
  .strict();
export type FutggCard = z.infer<typeof futggCardSchema>;

/** One of fut.gg's Gallery bonus tags: a share of the matching cards'
 * scores once enough cards match (`tiers`), by one rule. */
export const futggTagSchema = z
  .object({
    id: z.number().int(),
    name: z.string().max(60),
    tiers: z
      .array(
        z
          .object({
            minItems: z.number().int().min(0).max(100),
            bonus: z.number().min(0).max(1_000),
          })
          .strict(),
      )
      .max(10),
    rule: z
      .object({
        type: z.string().max(40),
        attribute: z.string().max(40),
        values: z.array(z.string().max(20)).max(20),
      })
      .strict(),
  })
  .strict();
export type FutggTag = z.infer<typeof futggTagSchema>;

export const futggLineupSchema = z
  .object({
    set: futggSetSummarySchema,
    grade: z.enum(GALLERY_GRADES),
    cards: z.array(futggCardSchema).max(100),
    /** Lineup cards fut.gg's card list for the Set does not describe. */
    missing: z.number().int().min(0).max(100),
    /** The Set's other cards, best scores first (owned ones can stand in
     * for lineup cards), and the bonus tags its score counts. */
    others: z.array(futggCardSchema).max(150).optional(),
    tags: z.array(futggTagSchema).max(40).optional(),
  })
  .strict();
export type FutggLineup = z.infer<typeof futggLineupSchema>;
