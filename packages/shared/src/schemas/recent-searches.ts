import { z } from 'zod';

import { coinPriceSchema } from './ingest-bounds.js';

/**
 * The Nova AI page's Recent searches log (apps/extension `ui/bot-page.ts`):
 * the last searches the bot was started on, newest first. Kept per account
 * by `GET`/`PUT /api/v1/extension/recent-searches`, so every browser the
 * trader signs in on shows the same list; the extension keeps a local copy
 * for when the API cannot be reached.
 *
 * Mirrors the page's stored `RecentSearch` exactly (its `TargetForm`, field
 * for field), with the bounds the page itself applies when it reads an entry
 * back. Its own module, with nothing but zod and the coin bound: only the
 * automation builds import it.
 */
export const RECENT_SEARCHES_MAX = 10;

/** The page's OVR slider range (`OVR_MIN`/`OVR_MAX` in ui/bot-page.ts). */
const ovrSchema = z.number().int().min(45).max(99);
/** One of EA's list ids (rarity, chemistry style, nation, league, club). */
const eaIdSchema = z.number().int().min(0);
const labelSchema = z.string().max(100);

export const recentSearchFormSchema = z
  .object({
    minOvr: ovrSchema,
    maxOvr: ovrSchema,
    player: z
      .object({
        id: z.number().int().positive(),
        name: labelSchema,
        rating: z.number().int().min(0).max(99).nullable(),
      })
      .strict()
      .nullable(),
    playerQuery: labelSchema,
    quality: labelSchema.nullable(),
    rarity: eaIdSchema.nullable(),
    position: labelSchema.nullable(),
    chem: eaIdSchema.nullable(),
    nation: eaIdSchema.nullable(),
    league: eaIdSchema.nullable(),
    club: eaIdSchema.nullable(),
    minBuy: coinPriceSchema.nullable(),
    maxBuy: coinPriceSchema.nullable(),
  })
  .strict();

export const recentSearchSchema = z
  .object({
    /** When the bot was started on it (ms since the epoch). */
    at: z.number().int().positive(),
    /** How the page described it then. */
    name: z.string().min(1).max(200),
    form: recentSearchFormSchema,
  })
  .strict();
export type RecentSearchDto = z.infer<typeof recentSearchSchema>;

const recentSearchListSchema = z.array(recentSearchSchema).max(RECENT_SEARCHES_MAX);

/** `PUT /extension/recent-searches` — replaces the whole list. */
export const putRecentSearchesRequestSchema = z.object({ items: recentSearchListSchema }).strict();
export type PutRecentSearchesRequest = z.infer<typeof putRecentSearchesRequestSchema>;

/** `updatedAt` is null until the account's first save. */
export const recentSearchesResponseSchema = z.object({
  items: recentSearchListSchema,
  updatedAt: z.string().datetime().nullable(),
});
export type RecentSearchesResponse = z.infer<typeof recentSearchesResponseSchema>;
