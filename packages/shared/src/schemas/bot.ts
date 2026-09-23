import { z } from 'zod';

/**
 * Settings for the extension's Sniping Bot page (apps/extension
 * `engine/sniper.ts`, `ui/bot-page.ts`). They live in the extension's own
 * storage, never on the server, and every one of them is the user's call:
 * the page offers safe and risky presets, and the user may go past either.
 *
 * `safety` holds the governor thresholds the bot runs under. It has the same
 * shape as the server-synced `GovernorSettings`, but its bounds are
 * `BOT_LIMITS`, which are far wider than `GOVERNOR_ABSOLUTE_LIMITS`: the
 * Sniping Bot is explicitly the "the user decides the risk" surface. The
 * server kill switch still applies whatever these say.
 */
export const BOT_LIMITS = {
  searchDelaySeconds: { min: 0.5, max: 600 },
  searchesBetweenBreaks: { min: 1, max: 10_000 },
  breakSeconds: { min: 1, max: 3_600 },
  restAfterMinutes: { min: 1, max: 1_440 },
  restMinutes: { min: 1, max: 1_440 },
  maxBuyPrice: { min: 0, max: 15_000_000 },
  minProfit: { min: 0, max: 15_000_000 },
  stopAfterPurchases: { min: 0, max: 100_000 },
  sessionCoinBudget: { min: 0, max: 1_000_000_000 },
  actionsPerHour: { min: 1, max: 7_200 },
  sessionLengthMinutes: { min: 5, max: 1_440 },
  buyToSearchRatio: { min: 0.01, max: 1 },
  cooldownSeconds: { min: 0, max: 3_600 },
  maxCoinFlowPerHour: { min: 1_000, max: 1_000_000_000 },
} as const;

type Bound = { min: number; max: number };

const int = (b: Bound) => z.number().int().min(b.min).max(b.max);
const num = (b: Bound) => z.number().min(b.min).max(b.max);

/** A "2-4"-style range: the bot picks a random value inside it each time. */
const range = (b: Bound, integer: boolean) =>
  z
    .object({ min: integer ? int(b) : num(b), max: integer ? int(b) : num(b) })
    .strict()
    .refine((r) => r.min <= r.max, { message: 'min must not be greater than max' });

export const botSettingsSchema = z
  .object({
    /** Seconds between two searches. */
    searchDelay: range(BOT_LIMITS.searchDelaySeconds, false),
    breaks: z
      .object({
        enabled: z.boolean(),
        /** Searches between two breaks. */
        searches: range(BOT_LIMITS.searchesBetweenBreaks, true),
        seconds: range(BOT_LIMITS.breakSeconds, true),
      })
      .strict(),
    rest: z
      .object({
        enabled: z.boolean(),
        /** Minutes of sniping before a rest. */
        afterMinutes: range(BOT_LIMITS.restAfterMinutes, true),
        minutes: range(BOT_LIMITS.restMinutes, true),
      })
      .strict(),
    thresholds: z
      .object({
        /** Never buy above this, whatever a filter allows. 0 = use each
         * filter's own max price. */
        maxBuyPrice: int(BOT_LIMITS.maxBuyPrice),
        /** Skip a listing whose estimated profit (after EA's 5% tax) is below
         * this. 0 = buy anything under the max price. */
        minProfit: int(BOT_LIMITS.minProfit),
        /** Stop the bot after this many purchases. 0 = no limit. */
        stopAfterPurchases: int(BOT_LIMITS.stopAfterPurchases),
        /** Stop the bot once it has spent this many coins. 0 = no limit. */
        sessionCoinBudget: int(BOT_LIMITS.sessionCoinBudget),
      })
      .strict(),
    safety: z
      .object({
        actionsPerHour: int(BOT_LIMITS.actionsPerHour),
        sessionLengthMinutes: int(BOT_LIMITS.sessionLengthMinutes),
        buyToSearchRatio: num(BOT_LIMITS.buyToSearchRatio),
        cooldownSeconds: int(BOT_LIMITS.cooldownSeconds),
        maxCoinFlowPerHour: int(BOT_LIMITS.maxCoinFlowPerHour),
      })
      .strict(),
  })
  .strict();
export type BotSettings = z.infer<typeof botSettingsSchema>;

/** Search-delay presets shown on the page, riskiest first. */
export const SEARCH_DELAY_PRESETS = [
  { key: 'risky', label: 'Risky', min: 1, max: 2 },
  { key: 'medium', label: 'Medium', min: 2, max: 4 },
  { key: 'safe', label: 'Safe', min: 3, max: 5 },
] as const;

/** Whole-bot safety presets: the governor thresholds that go with a pace. */
export const SAFETY_PRESETS = {
  low: {
    actionsPerHour: 300,
    sessionLengthMinutes: 60,
    buyToSearchRatio: 0.2,
    cooldownSeconds: 300,
    maxCoinFlowPerHour: 500_000,
  },
  medium: {
    actionsPerHour: 900,
    sessionLengthMinutes: 120,
    buyToSearchRatio: 0.35,
    cooldownSeconds: 120,
    maxCoinFlowPerHour: 2_000_000,
  },
  high: {
    actionsPerHour: 2_400,
    sessionLengthMinutes: 360,
    buyToSearchRatio: 0.6,
    cooldownSeconds: 30,
    maxCoinFlowPerHour: 20_000_000,
  },
} as const satisfies Record<string, BotSettings['safety']>;
export type SafetyPresetKey = keyof typeof SAFETY_PRESETS;

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  searchDelay: { min: 3, max: 5 },
  breaks: { enabled: true, searches: { min: 15, max: 15 }, seconds: { min: 10, max: 10 } },
  rest: { enabled: true, afterMinutes: { min: 20, max: 30 }, minutes: { min: 15, max: 20 } },
  thresholds: { maxBuyPrice: 0, minProfit: 1_000, stopAfterPurchases: 0, sessionCoinBudget: 0 },
  safety: { ...SAFETY_PRESETS.medium },
};

/** Rough searches per hour a set of pacing settings produces, breaks and
 * rests included — what the page's risk badge is based on. */
export function estimatedSearchesPerHour(s: BotSettings): number {
  const delay = (s.searchDelay.min + s.searchDelay.max) / 2;
  let secondsPerSearch = delay;
  if (s.breaks.enabled) {
    const searches = (s.breaks.searches.min + s.breaks.searches.max) / 2;
    secondsPerSearch += (s.breaks.seconds.min + s.breaks.seconds.max) / 2 / searches;
  }
  let perHour = 3_600 / secondsPerSearch;
  if (s.rest.enabled) {
    const on = (s.rest.afterMinutes.min + s.rest.afterMinutes.max) / 2;
    const off = (s.rest.minutes.min + s.rest.minutes.max) / 2;
    perHour *= on / (on + off);
  }
  return Math.round(perHour);
}

export type BotRiskLevel = 'low' | 'medium' | 'high';

/** Low under ~300 searches an hour, high from ~900. */
export function botRiskLevel(s: BotSettings): BotRiskLevel {
  const perHour = Math.min(estimatedSearchesPerHour(s), s.safety.actionsPerHour);
  if (perHour >= 900) return 'high';
  if (perHour >= 300) return 'medium';
  return 'low';
}
