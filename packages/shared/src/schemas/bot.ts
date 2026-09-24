import { z } from 'zod';

import {
  DEFAULT_GOVERNOR_SETTINGS,
  GOVERNOR_ABSOLUTE_LIMITS,
  type GovernorSettings,
} from './settings.js';

/**
 * Settings for the extension's Sniping Bot page (apps/extension
 * `engine/sniper.ts`, `ui/bot-page.ts`). They live in the extension's own
 * storage, never on the server.
 *
 * `safety` holds the governor thresholds the bot runs under. It has the same
 * shape as the server-synced `GovernorSettings`. How far it may go depends on
 * `safetyMode`:
 *
 *   - `'recommended'` (the default): the bot's effective limits are clamped
 *     to the user's own governor settings (themselves bounded by
 *     `GOVERNOR_ABSOLUTE_LIMITS`), and the search delay is raised so the pace
 *     cannot run past those caps. See `effectiveBotSettings`.
 *   - `'custom'`: the user turned the recommended limits off, after
 *     explicitly accepting the higher ban risk (`customRiskAcknowledgedAt`).
 *     `BOT_LIMITS` apply, which are far wider.
 *
 * The server kill switch and the adapter checks stop the bot in both modes.
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

export const BOT_SAFETY_MODES = ['recommended', 'custom'] as const;
export type BotSafetyMode = (typeof BOT_SAFETY_MODES)[number];

/** What the user must tick before custom limits turn on. Shown verbatim on
 * the Sniping Bot page. */
export const CUSTOM_LIMITS_ACKNOWLEDGMENT =
  'I understand that going faster than the recommended limits raises the risk of an EA ban, and that a ban is never refundable';

export const botSettingsSchema = z
  .object({
    /** Recommended limits on (the default) or off. Settings saved before this
     * field existed, and any value that is not a known mode, read as
     * `'recommended'`. */
    safetyMode: z.enum(BOT_SAFETY_MODES).default('recommended').catch('recommended'),
    /** When the user accepted `CUSTOM_LIMITS_ACKNOWLEDGMENT` (ISO 8601).
     * Custom mode without it runs as recommended (`effectiveSafetyMode`). */
    customRiskAcknowledgedAt: z.string().datetime().nullable().default(null).catch(null),
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

/** Search-delay presets for custom mode, riskiest first. Recommended mode
 * uses `searchDelayPresets` instead, which derives them from the caps. */
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
  safetyMode: 'recommended',
  customRiskAcknowledgedAt: null,
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

// ---- recommended vs custom limits -----------------------------------------

type SafetyKey = keyof BotSettings['safety'];
const SAFETY_KEYS: readonly SafetyKey[] = [
  'actionsPerHour',
  'sessionLengthMinutes',
  'buyToSearchRatio',
  'cooldownSeconds',
  'maxCoinFlowPerHour',
];

/** The bounds the bot's own governor clamps to in custom mode. */
export const BOT_SAFETY_LIMITS: Record<SafetyKey, Bound> = {
  actionsPerHour: BOT_LIMITS.actionsPerHour,
  sessionLengthMinutes: BOT_LIMITS.sessionLengthMinutes,
  buyToSearchRatio: BOT_LIMITS.buyToSearchRatio,
  cooldownSeconds: BOT_LIMITS.cooldownSeconds,
  maxCoinFlowPerHour: BOT_LIMITS.maxCoinFlowPerHour,
};

const clampTo = (b: Bound, value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(b.max, Math.max(b.min, value)) : fallback;

/** Custom mode only counts once the risk was acknowledged: a stored
 * `'custom'` without a valid acknowledgment runs as recommended. */
export function effectiveSafetyMode(
  s: Pick<BotSettings, 'safetyMode' | 'customRiskAcknowledgedAt'>,
): BotSafetyMode {
  if (s.safetyMode !== 'custom') return 'recommended';
  const at = s.customRiskAcknowledgedAt;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? 'custom' : 'recommended';
}

/** The caps recommended mode holds the bot to: the user's governor settings
 * (null = not loaded, use the shipped defaults), clamped into
 * `GOVERNOR_ABSOLUTE_LIMITS` so a corrupt or hand-edited cache cannot widen
 * them. */
export function recommendedCaps(governor: GovernorSettings | null | undefined): GovernorSettings {
  const g = governor ?? DEFAULT_GOVERNOR_SETTINGS;
  const out = {} as GovernorSettings;
  for (const k of SAFETY_KEYS) {
    out[k] = clampTo(GOVERNOR_ABSOLUTE_LIMITS[k], g[k], DEFAULT_GOVERNOR_SETTINGS[k]);
  }
  return out;
}

/** The shortest average gap between two searches that keeps the bot inside
 * `caps.actionsPerHour`, counting the buys each search may lead to (at most
 * `buyToSearchRatio` per search). */
export function minSearchDelaySeconds(
  caps: Pick<GovernorSettings, 'actionsPerHour' | 'buyToSearchRatio'>,
): number {
  return (3_600 * (1 + caps.buyToSearchRatio)) / caps.actionsPerHour;
}

export interface EffectiveBotSettings extends BotSettings {
  /** The mode actually in force (see `effectiveSafetyMode`). */
  mode: BotSafetyMode;
  /** Recommended mode's caps; null in custom mode. */
  caps: GovernorSettings | null;
  /** The shortest search delay the engine will use. */
  minSearchDelaySeconds: number;
}

/**
 * What the bot actually runs on. The engine calls this on every start and
 * settings change, so the clamping holds whatever the page or storage says.
 *
 * Recommended mode: each safety limit is the tighter of the user's value and
 * the cap (for the cooldown, the longer one), and the search delay is raised
 * to at least `minSearchDelaySeconds` of those limits. Breaks and rests only
 * ever add waiting, so they cannot push the pace past the caps.
 *
 * Custom mode: the user's values, clamped into `BOT_LIMITS`.
 */
export function effectiveBotSettings(
  s: BotSettings,
  governor: GovernorSettings | null | undefined,
): EffectiveBotSettings {
  const mode = effectiveSafetyMode(s);
  const own = {} as BotSettings['safety'];
  for (const k of SAFETY_KEYS) {
    own[k] = clampTo(BOT_SAFETY_LIMITS[k], s.safety[k], DEFAULT_BOT_SETTINGS.safety[k]);
  }
  const delayBound = BOT_LIMITS.searchDelaySeconds;
  const delayMin = clampTo(delayBound, s.searchDelay.min, DEFAULT_BOT_SETTINGS.searchDelay.min);
  const delayMax = Math.max(delayMin, clampTo(delayBound, s.searchDelay.max, delayMin));

  if (mode === 'custom') {
    return {
      ...s,
      mode,
      caps: null,
      safety: own,
      searchDelay: { min: delayMin, max: delayMax },
      minSearchDelaySeconds: delayBound.min,
    };
  }

  const caps = recommendedCaps(governor);
  const safety: BotSettings['safety'] = {
    actionsPerHour: Math.min(own.actionsPerHour, caps.actionsPerHour),
    sessionLengthMinutes: Math.min(own.sessionLengthMinutes, caps.sessionLengthMinutes),
    buyToSearchRatio: Math.min(own.buyToSearchRatio, caps.buyToSearchRatio),
    cooldownSeconds: Math.max(own.cooldownSeconds, caps.cooldownSeconds),
    maxCoinFlowPerHour: Math.min(own.maxCoinFlowPerHour, caps.maxCoinFlowPerHour),
  };
  const floor = minSearchDelaySeconds(safety);
  const min = Math.max(delayMin, floor);
  return {
    ...s,
    mode,
    caps,
    safety,
    searchDelay: { min, max: Math.max(delayMax, min) },
    minSearchDelaySeconds: floor,
  };
}

/**
 * Switch the safety mode. Turning custom limits on needs the user's explicit
 * acknowledgment of `CUSTOM_LIMITS_ACKNOWLEDGMENT` (the page's required
 * checkbox) and records when it was given; without it this throws. Going
 * back to recommended clears the acknowledgment, so the next switch asks
 * again.
 */
export function withSafetyMode(
  s: BotSettings,
  mode: BotSafetyMode,
  opts: { acknowledged?: boolean; now?: Date } = {},
): BotSettings {
  if (mode === 'recommended') {
    return { ...s, safetyMode: 'recommended', customRiskAcknowledgedAt: null };
  }
  if (opts.acknowledged !== true) {
    throw new Error('Custom limits need the risk acknowledgment first.');
  }
  return {
    ...s,
    safetyMode: 'custom',
    customRiskAcknowledgedAt: (opts.now ?? new Date()).toISOString(),
  };
}

export interface SearchDelayPreset {
  key: string;
  label: string;
  /** Colour of the preset's tag. */
  tone: 'safe' | 'medium' | 'risky';
  min: number;
  max: number;
}

/**
 * The search-delay presets for a mode. Recommended mode derives all three
 * from the caps, so each stays inside them: "Fastest allowed" starts at the
 * shortest delay the caps permit (rounded up to a whole second), and
 * "Balanced" and "Careful" are slower multiples of it. Custom mode shows the
 * fixed `SEARCH_DELAY_PRESETS`, riskiest first.
 */
export function searchDelayPresets(
  mode: BotSafetyMode,
  minDelaySeconds: number,
): SearchDelayPreset[] {
  if (mode === 'custom') {
    return SEARCH_DELAY_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      tone: p.key === 'risky' ? 'risky' : p.key === 'medium' ? 'medium' : 'safe',
      min: p.min,
      max: p.max,
    }));
  }
  const b = BOT_LIMITS.searchDelaySeconds;
  const sec = (n: number) => Math.min(b.max, Math.max(b.min, Math.ceil(n)));
  const m = Math.max(minDelaySeconds, b.min);
  return [
    { key: 'careful', label: 'Careful', tone: 'safe', min: sec(m * 2), max: sec(m * 3) },
    { key: 'balanced', label: 'Balanced', tone: 'safe', min: sec(m * 1.5), max: sec(m * 2) },
    { key: 'fastest', label: 'Fastest allowed', tone: 'medium', min: sec(m), max: sec(m * 1.25) },
  ];
}
