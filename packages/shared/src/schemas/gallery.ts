import { z } from 'zod';

/**
 * Nova AI's Gallery mode (apps/extension `engine/gallery.ts`): the trader's
 * list of cards to collect for FC's Gallery Sets, each card's progress, and
 * the coin budget for the list. EA's web app has no Gallery, so Nova cannot
 * read a Set's grade: it works from this list, buys each card, sends it to
 * the club (so the Set counts it) and lists it again at once.
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
  noteLength: 200,
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
 */
export const GALLERY_CARD_STATUSES = ['todo', 'bought', 'club', 'listed', 'skipped'] as const;
export type GalleryCardStatus = (typeof GALLERY_CARD_STATUSES)[number];

const coins = z.number().int().min(0).max(15_000_000);

export const galleryCardSchema = z
  .object({
    /** Unique on the list: the player and rating. */
    key: z.string().min(1).max(80),
    /** The player's name as EA's player list has it. */
    name: z.string().min(1).max(GALLERY_LIMITS.nameLength),
    rating: z.number().int().min(GALLERY_LIMITS.rating.min).max(GALLERY_LIMITS.rating.max),
    /** EA's base player id (what a search asks for, `maskedDefId`). */
    playerId: z.number().int().positive(),
    /** The card's own id (its version), once known: equal to `playerId` for
     * a player's base card, else learned from the first search. */
    resourceId: z.number().int().positive().optional(),
    /** The Set heading the card was listed under, if any. */
    set: z.string().max(GALLERY_LIMITS.setLength).optional(),
    status: z.enum(GALLERY_CARD_STATUSES),
    /** What it was bought for. */
    price: coins.optional(),
    /** The market price it was judged by (FUTBIN's, else Nova's). */
    market: coins.optional(),
    /** The buy-now price it was listed at. */
    listPrice: coins.optional(),
    /** Why it was skipped, or what went wrong after the buy. */
    note: z.string().max(GALLERY_LIMITS.noteLength).optional(),
  })
  .strict();
export type GalleryCard = z.infer<typeof galleryCardSchema>;

export const galleryStateSchema = z
  .object({
    cards: z.array(galleryCardSchema).max(GALLERY_LIMITS.cards),
    /** The most the list may spend on buys (0: nothing is bought). */
    budget: z.number().int().min(GALLERY_LIMITS.budget.min).max(GALLERY_LIMITS.budget.max),
    /** Coins spent on the list's buys so far. */
    spent: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type GalleryState = z.infer<typeof galleryStateSchema>;

export const EMPTY_GALLERY: GalleryState = { cards: [], budget: 100_000, spent: 0 };
