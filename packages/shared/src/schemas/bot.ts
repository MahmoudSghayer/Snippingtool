import { z } from 'zod';

import type { GovernorSettings } from './settings.js';

/**
 * Settings for the extension's Sniping Bot page (apps/extension
 * `engine/sniper.ts`, `ui/bot-page.ts`). They live in the extension's own
 * storage, never on the server.
 *
 * The bot starts on the recommended limits (`RECOMMENDED_BOT_SETTINGS`), and
 * the user can change any of them within `BOT_LIMITS`, the hard technical
 * bounds. `botRiskLevel()` rates how risky the user's numbers are; the page
 * shows it live, and asks for a one-time acknowledgment
 * (`riskAcknowledgedAt`) the first time the user saves settings above low.
 * The engine runs on the user's own numbers and enforces every one of them.
 * The server kill switch and the adapter checks stop the bot whatever the
 * settings say.
 */
export const BOT_LIMITS = {
  searchDelaySeconds: { min: 0.5, max: 600 },
  searchesBetweenBreaks: { min: 1, max: 10_000 },
  breakSeconds: { min: 1, max: 3_600 },
  /** Session length: minutes of sniping before a rest. */
  restAfterMinutes: { min: 1, max: 1_440 },
  restMinutes: { min: 1, max: 1_440 },
  maxBuyPrice: { min: 0, max: 15_000_000 },
  minProfit: { min: 0, max: 15_000_000 },
  stopAfterPurchases: { min: 0, max: 100_000 },
  sessionCoinBudget: { min: 0, max: 1_000_000_000 },
  maxSearchesPerHour: { min: 1, max: 7_200 },
  maxBuysPerHour: { min: 1, max: 1_000 },
  maxActiveHoursPerDay: { min: 1, max: 24 },
  buyToSearchRatio: { min: 0.01, max: 1 },
  /** Cooldown after a buy. */
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

/** What the user ticks the first time they save settings above low risk.
 * Shown verbatim on the Sniping Bot page. */
export const RISK_ACKNOWLEDGMENT =
  'I understand these settings raise the risk of an EA ban, and that a ban is never refundable';

/** The recommended limits: the defaults, and what "Reset to recommended"
 * restores. They rate `low` (a test pins that). */
export const RECOMMENDED_BOT_SETTINGS = {
  searchDelay: { min: 8, max: 12 },
  breaks: { enabled: true, searches: { min: 15, max: 15 }, seconds: { min: 10, max: 10 } },
  /** A 60-minute session, then a 20-minute rest. */
  rest: { enabled: true, afterMinutes: { min: 60, max: 60 }, minutes: { min: 20, max: 20 } },
  safety: {
    maxSearchesPerHour: 250,
    maxBuysPerHour: 15,
    maxActiveHoursPerDay: 6,
    maxCoinFlowPerHour: 500_000,
    /** After every buy. */
    cooldownSeconds: 10,
    buyToSearchRatio: 0.35,
  },
} as const;

const R = RECOMMENDED_BOT_SETTINGS;
const rangeDefault = (r: { min: number; max: number }) => ({ min: r.min, max: r.max });

/** Fields older builds stored that this one no longer uses: accepted so old
 * settings still parse, and otherwise ignored. */
const legacy = z.unknown().optional();

export const botSettingsSchema = z
  .object({
    /** Legacy (the earlier recommended/custom switch). Ignored. */
    safetyMode: legacy,
    /** Legacy. Ignored. */
    customRiskAcknowledgedAt: legacy,
    /** When the user accepted `RISK_ACKNOWLEDGMENT` (ISO 8601), the first time
     * they saved settings above low risk. Null until then. */
    riskAcknowledgedAt: z.string().datetime().nullable().default(null).catch(null),
    /** Seconds between two searches. */
    searchDelay: range(BOT_LIMITS.searchDelaySeconds, false).default(rangeDefault(R.searchDelay)),
    breaks: z
      .object({
        enabled: z.boolean(),
        /** Searches between two breaks. */
        searches: range(BOT_LIMITS.searchesBetweenBreaks, true),
        seconds: range(BOT_LIMITS.breakSeconds, true),
      })
      .strict()
      .default({
        enabled: R.breaks.enabled,
        searches: rangeDefault(R.breaks.searches),
        seconds: rangeDefault(R.breaks.seconds),
      }),
    rest: z
      .object({
        enabled: z.boolean(),
        /** Session length: minutes of sniping before a rest. */
        afterMinutes: range(BOT_LIMITS.restAfterMinutes, true),
        minutes: range(BOT_LIMITS.restMinutes, true),
      })
      .strict()
      .default({
        enabled: R.rest.enabled,
        afterMinutes: rangeDefault(R.rest.afterMinutes),
        minutes: rangeDefault(R.rest.minutes),
      }),
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
      .strict()
      .default({ maxBuyPrice: 0, minProfit: 1_000, stopAfterPurchases: 0, sessionCoinBudget: 0 }),
    safety: z
      .object({
        maxSearchesPerHour: int(BOT_LIMITS.maxSearchesPerHour).default(R.safety.maxSearchesPerHour),
        maxBuysPerHour: int(BOT_LIMITS.maxBuysPerHour).default(R.safety.maxBuysPerHour),
        maxActiveHoursPerDay: num(BOT_LIMITS.maxActiveHoursPerDay).default(
          R.safety.maxActiveHoursPerDay,
        ),
        buyToSearchRatio: num(BOT_LIMITS.buyToSearchRatio).default(R.safety.buyToSearchRatio),
        /** Seconds to wait after every buy. */
        cooldownSeconds: int(BOT_LIMITS.cooldownSeconds).default(R.safety.cooldownSeconds),
        maxCoinFlowPerHour: int(BOT_LIMITS.maxCoinFlowPerHour).default(R.safety.maxCoinFlowPerHour),
        /** Legacy: replaced by maxSearchesPerHour + maxBuysPerHour. Ignored. */
        actionsPerHour: legacy,
        /** Legacy: the session is the rest cycle plus maxActiveHoursPerDay. Ignored. */
        sessionLengthMinutes: legacy,
      })
      .strict()
      .default({}),
  })
  .strict();
export type BotSettings = z.infer<typeof botSettingsSchema>;

export const DEFAULT_BOT_SETTINGS: BotSettings = botSettingsSchema.parse({});

/** The recommended limits applied to `s`, keeping the user's targets and
 * thresholds. What "Reset to recommended" does. */
export function withRecommendedLimits(s: BotSettings): BotSettings {
  return {
    ...s,
    searchDelay: { ...DEFAULT_BOT_SETTINGS.searchDelay },
    breaks: structuredCloneRanges(DEFAULT_BOT_SETTINGS.breaks),
    rest: structuredCloneRanges(DEFAULT_BOT_SETTINGS.rest),
    safety: {
      maxSearchesPerHour: R.safety.maxSearchesPerHour,
      maxBuysPerHour: R.safety.maxBuysPerHour,
      maxActiveHoursPerDay: R.safety.maxActiveHoursPerDay,
      buyToSearchRatio: R.safety.buyToSearchRatio,
      cooldownSeconds: R.safety.cooldownSeconds,
      maxCoinFlowPerHour: R.safety.maxCoinFlowPerHour,
    },
  };
}

function structuredCloneRanges<T extends Record<string, unknown>>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

// ---- engine bounds ----------------------------------------------------------

const clampTo = (b: Bound, value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(b.max, Math.max(b.min, value))
    : fallback;

function clampRange(
  b: Bound,
  r: { min: number; max: number } | undefined,
  fallback: { min: number; max: number },
  integer: boolean,
): { min: number; max: number } {
  const round = (n: number) => (integer ? Math.round(n) : n);
  const min = round(clampTo(b, r?.min, fallback.min));
  const max = round(clampTo(b, r?.max, fallback.max));
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/**
 * The settings clamped into `BOT_LIMITS`, field by field (a non-number falls
 * back to the default). The engine runs on this, so a value that got into
 * storage or the page without passing `botSettingsSchema` can never take
 * the bot past the technical bounds.
 */
export function clampBotSettings(s: BotSettings): BotSettings {
  const d = DEFAULT_BOT_SETTINGS;
  const L = BOT_LIMITS;
  const safety = (s.safety ?? {}) as Partial<BotSettings['safety']>;
  const th = (s.thresholds ?? {}) as Partial<BotSettings['thresholds']>;
  return {
    riskAcknowledgedAt: s.riskAcknowledgedAt ?? null,
    searchDelay: clampRange(L.searchDelaySeconds, s.searchDelay, d.searchDelay, false),
    breaks: {
      enabled: s.breaks?.enabled ?? d.breaks.enabled,
      searches: clampRange(L.searchesBetweenBreaks, s.breaks?.searches, d.breaks.searches, true),
      seconds: clampRange(L.breakSeconds, s.breaks?.seconds, d.breaks.seconds, true),
    },
    rest: {
      enabled: s.rest?.enabled ?? d.rest.enabled,
      afterMinutes: clampRange(L.restAfterMinutes, s.rest?.afterMinutes, d.rest.afterMinutes, true),
      minutes: clampRange(L.restMinutes, s.rest?.minutes, d.rest.minutes, true),
    },
    thresholds: {
      maxBuyPrice: clampTo(L.maxBuyPrice, th.maxBuyPrice, d.thresholds.maxBuyPrice),
      minProfit: clampTo(L.minProfit, th.minProfit, d.thresholds.minProfit),
      stopAfterPurchases: clampTo(
        L.stopAfterPurchases,
        th.stopAfterPurchases,
        d.thresholds.stopAfterPurchases,
      ),
      sessionCoinBudget: clampTo(
        L.sessionCoinBudget,
        th.sessionCoinBudget,
        d.thresholds.sessionCoinBudget,
      ),
    },
    safety: {
      maxSearchesPerHour: Math.round(
        clampTo(L.maxSearchesPerHour, safety.maxSearchesPerHour, d.safety.maxSearchesPerHour),
      ),
      maxBuysPerHour: Math.round(
        clampTo(L.maxBuysPerHour, safety.maxBuysPerHour, d.safety.maxBuysPerHour),
      ),
      maxActiveHoursPerDay: clampTo(
        L.maxActiveHoursPerDay,
        safety.maxActiveHoursPerDay,
        d.safety.maxActiveHoursPerDay,
      ),
      buyToSearchRatio: clampTo(
        L.buyToSearchRatio,
        safety.buyToSearchRatio,
        d.safety.buyToSearchRatio,
      ),
      cooldownSeconds: clampTo(L.cooldownSeconds, safety.cooldownSeconds, d.safety.cooldownSeconds),
      maxCoinFlowPerHour: clampTo(
        L.maxCoinFlowPerHour,
        safety.maxCoinFlowPerHour,
        d.safety.maxCoinFlowPerHour,
      ),
    },
  };
}

/** The bounds the Sniping Bot's own governor clamps to (instead of the
 * server-synced `GOVERNOR_ABSOLUTE_LIMITS`, which are for assist mode and
 * the autobuyer). */
export const BOT_GOVERNOR_BOUNDS: Record<keyof GovernorSettings, Bound> = {
  actionsPerHour: {
    min: 2,
    max: BOT_LIMITS.maxSearchesPerHour.max + BOT_LIMITS.maxBuysPerHour.max,
  },
  // The session is enforced by the rest cycle and maxActiveHoursPerDay in
  // the engine; the governor's own session clock is set out of the way.
  sessionLengthMinutes: { min: 5, max: 525_600 },
  buyToSearchRatio: BOT_LIMITS.buyToSearchRatio,
  cooldownSeconds: BOT_LIMITS.cooldownSeconds,
  maxCoinFlowPerHour: BOT_LIMITS.maxCoinFlowPerHour,
};

/** The governor thresholds the bot runs under, from the user's settings:
 * every search and buy counts toward maxSearchesPerHour + maxBuysPerHour
 * (the engine also counts each kind on its own). */
export function botGovernorSettings(s: BotSettings): GovernorSettings {
  const c = clampBotSettings(s);
  return {
    actionsPerHour: c.safety.maxSearchesPerHour + c.safety.maxBuysPerHour,
    sessionLengthMinutes: BOT_GOVERNOR_BOUNDS.sessionLengthMinutes.max,
    buyToSearchRatio: c.safety.buyToSearchRatio,
    cooldownSeconds: c.safety.cooldownSeconds,
    maxCoinFlowPerHour: c.safety.maxCoinFlowPerHour,
  };
}

// ---- risk level ----------------------------------------------------------------

export const BOT_RISK_LEVELS = ['low', 'moderate', 'high', 'very_high'] as const;
export type BotRiskLevel = (typeof BOT_RISK_LEVELS)[number];

export const BOT_RISK_LABELS: Record<BotRiskLevel, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  very_high: 'Very high',
};

/**
 * The upper bound of each tier (lower bound for the delay), from limits
 * traders have reported for EA's transfer market. EA doesn't publish its
 * rules, so these are estimates, not guarantees. Anything past `high` is
 * `very_high`.
 */
export const BOT_RISK_THRESHOLDS = {
  searchesPerDay: { low: 2_000, moderate: 3_500, high: 5_000 },
  buysPerDay: { low: 100, moderate: 150, high: 250 },
  /** Shortest search delay, seconds: at least this for the tier. */
  minDelaySeconds: { low: 6, moderate: 4, high: 2 },
  /** Coins the bot may spend an hour (`maxCoinFlowPerHour`). */
  coinsPerHour: { low: 1_000_000, moderate: 3_000_000, high: 10_000_000 },
  /** Cooldown after a buy, seconds: at least this for the tier. */
  cooldownSeconds: { low: 8, moderate: 4, high: 1 },
  /** Buys allowed per search (`buyToSearchRatio`). */
  buyToSearchRatio: { low: 0.35, moderate: 0.5, high: 0.75 },
} as const;

export interface BotRisk {
  level: BotRiskLevel;
  /** One plain sentence per factor above low. Empty when low. */
  reasons: string[];
  projectedSearchesPerDay: number;
  projectedBuysPerDay: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const rank = (l: BotRiskLevel) => BOT_RISK_LEVELS.indexOf(l);

/** Hours a day the bot can be active: the session/rest duty cycle (the
 * longest session, the shortest rest) over 24 hours, capped by
 * maxActiveHoursPerDay. */
export function projectedActiveHoursPerDay(s: BotSettings): number {
  const c = clampBotSettings(s);
  const on = c.rest.afterMinutes.max;
  const off = c.rest.minutes.min;
  const dutyCycle = c.rest.enabled ? on / (on + off) : 1;
  return Math.min(24 * dutyCycle, c.safety.maxActiveHoursPerDay);
}

/**
 * How risky the user's settings are, live. Every limit the user can raise
 * that changes how the bot looks to EA is a factor, each rated on
 * `BOT_RISK_THRESHOLDS`; the worst one wins:
 *
 *   - searches a day = min(maxSearchesPerHour, 3600 / shortest delay)
 *     × active hours a day (`projectedActiveHoursPerDay`)
 *   - buys a day     = maxBuysPerHour × active hours a day
 *   - the shortest search delay itself
 *   - coins spent an hour (maxCoinFlowPerHour)
 *   - the cooldown after a buy
 *   - the buy-to-search ratio
 *
 * Deliberately not a factor: the max buy price (`thresholds.maxBuyPrice`,
 * and each filter's own max price). It caps what one buy may cost, not how
 * often or how fast the bot acts, so it does not change how detectable the
 * bot is; the coins-per-hour factor already rates how much it can spend.
 *
 * The engine refuses to start (and stops) on anything above `low` until the
 * user has acknowledged the risk (`riskAcknowledgedAt`), whichever factor
 * raised it (apps/extension `engine/sniper.ts`).
 */
export function botRiskLevel(s: BotSettings): BotRisk {
  const c = clampBotSettings(s);
  const T = BOT_RISK_THRESHOLDS;
  const hours = projectedActiveHoursPerDay(c);
  const minDelay = c.searchDelay.min;
  const searchesPerHour = Math.min(c.safety.maxSearchesPerHour, 3_600 / minDelay);
  const searchesPerDay = searchesPerHour * hours;
  const buysPerDay = c.safety.maxBuysPerHour * hours;

  const upTo = (value: number, t: { low: number; moderate: number; high: number }): BotRiskLevel =>
    value <= t.low
      ? 'low'
      : value <= t.moderate
        ? 'moderate'
        : value <= t.high
          ? 'high'
          : 'very_high';
  const atLeast = (
    value: number,
    t: { low: number; moderate: number; high: number },
  ): BotRiskLevel =>
    value >= t.low
      ? 'low'
      : value >= t.moderate
        ? 'moderate'
        : value >= t.high
          ? 'high'
          : 'very_high';

  /** The tier just below `level`, whose limit the value went past. */
  const below = (level: BotRiskLevel) =>
    BOT_RISK_LEVELS[rank(level) - 1] as Exclude<BotRiskLevel, 'very_high'>;

  const reasons: string[] = [];
  const searchesLevel = upTo(searchesPerDay, T.searchesPerDay);
  if (searchesLevel !== 'low') {
    const b = below(searchesLevel);
    reasons.push(
      `About ${fmt(searchesPerDay)} searches a day — above the ~${fmt(T.searchesPerDay[b])} ${b} limit`,
    );
  }
  const buysLevel = upTo(buysPerDay, T.buysPerDay);
  if (buysLevel !== 'low') {
    const b = below(buysLevel);
    reasons.push(
      `About ${fmt(buysPerDay)} buys a day — above the ~${fmt(T.buysPerDay[b])} ${b} limit`,
    );
  }
  const delayLevel = atLeast(minDelay, T.minDelaySeconds);
  if (delayLevel !== 'low') {
    const b = below(delayLevel);
    reasons.push(
      `Searches as little as ${minDelay} s apart — under the ${T.minDelaySeconds[b]} s ${b} minimum`,
    );
  }

  const coinsPerHour = c.safety.maxCoinFlowPerHour;
  const coinsLevel = upTo(coinsPerHour, T.coinsPerHour);
  if (coinsLevel !== 'low') {
    const b = below(coinsLevel);
    reasons.push(
      `Up to ${fmt(coinsPerHour)} coins an hour — above the ${fmt(T.coinsPerHour[b])} ${b} limit`,
    );
  }
  const cooldown = c.safety.cooldownSeconds;
  const cooldownLevel = atLeast(cooldown, T.cooldownSeconds);
  if (cooldownLevel !== 'low') {
    const b = below(cooldownLevel);
    reasons.push(
      `A ${cooldown} s cooldown after a buy — under the ${T.cooldownSeconds[b]} s ${b} minimum`,
    );
  }
  const ratio = c.safety.buyToSearchRatio;
  const ratioLevel = upTo(ratio, T.buyToSearchRatio);
  if (ratioLevel !== 'low') {
    const b = below(ratioLevel);
    reasons.push(`Up to ${ratio} buys per search — above the ${T.buyToSearchRatio[b]} ${b} limit`);
  }

  const level = [
    searchesLevel,
    buysLevel,
    delayLevel,
    coinsLevel,
    cooldownLevel,
    ratioLevel,
  ].reduce((worst, l) => (rank(l) > rank(worst) ? l : worst));
  return {
    level,
    reasons,
    projectedSearchesPerDay: Math.round(searchesPerDay),
    projectedBuysPerDay: Math.round(buysPerDay),
  };
}

/** Search-delay quick fills, slowest first. The page labels each with the
 * risk level it produces with the user's other settings. */
export const SEARCH_DELAY_PRESETS = [
  { key: 'recommended', min: 8, max: 12 },
  { key: 'brisk', min: 5, max: 8 },
  { key: 'fast', min: 3, max: 5 },
  { key: 'fastest', min: 1, max: 2 },
] as const;

/** One day's active (non-rest) running time, for maxActiveHoursPerDay. Kept
 * in `storage.local` so a page reload doesn't reset it. */
export const botDailyUsageSchema = z
  .object({
    /** Local calendar day, YYYY-MM-DD. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    activeMs: z.number().int().min(0).max(86_400_000),
  })
  .strict();
export type BotDailyUsage = z.infer<typeof botDailyUsageSchema>;
