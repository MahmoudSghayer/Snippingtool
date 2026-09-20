import { z } from 'zod';

/** A saved transfer-market search filter, mirroring the FC web app's own
 * filter fields (never a raw request — this is just parameters the user
 * entered into the app's own search form). */
export const filterCriteriaSchema = z.object({
  resourceId: z.number().int().positive().optional(),
  minPrice: z.number().int().min(0).optional(),
  maxPrice: z.number().int().min(0).optional(),
  minRating: z.number().int().min(0).max(99).optional(),
  maxRating: z.number().int().min(0).max(99).optional(),
  position: z.string().min(1).max(10).optional(),
  nationality: z.number().int().positive().optional(),
  league: z.number().int().positive().optional(),
  club: z.number().int().positive().optional(),
  quality: z.enum(['bronze', 'silver', 'gold', 'special']).optional(),
});
export type FilterCriteria = z.infer<typeof filterCriteriaSchema>;

export const savedFilterSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  filter: filterCriteriaSchema,
  filterHash: z.string().min(1).max(128),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0),
  createdAt: z.string().datetime(),
});
export type SavedFilter = z.infer<typeof savedFilterSchema>;

export const createSavedFilterRequestSchema = z.object({
  name: z.string().min(1).max(80),
  filter: filterCriteriaSchema,
});
export type CreateSavedFilterRequest = z.infer<typeof createSavedFilterRequestSchema>;

export const updateSavedFilterRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  filter: filterCriteriaSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type UpdateSavedFilterRequest = z.infer<typeof updateSavedFilterRequestSchema>;

/**
 * Realised-return history for one filter, synced from the extension so the
 * ranker's rotation/retirement logic (docs/01-architecture.md, engine/ranker)
 * survives a reinstall. One row per rolling window.
 */
export const filterStatsSchema = z.object({
  filterId: z.string().uuid(),
  windowStart: z.string().datetime(),
  searches: z.number().int().min(0),
  attempts: z.number().int().min(0),
  successes: z.number().int().min(0),
  coinsSpent: z.number().int().min(0),
  coinsEarned: z.number().int().min(0),
  coinsPerHour: z.number(),
});
export type FilterStats = z.infer<typeof filterStatsSchema>;

export const reportFilterStatsRequestSchema = z.object({
  stats: z.array(filterStatsSchema).min(1).max(200),
});
export type ReportFilterStatsRequest = z.infer<typeof reportFilterStatsRequestSchema>;
