import { describe, expect, it } from 'vitest';

import {
  BOT_LIMITS,
  DEFAULT_BOT_SETTINGS,
  RECOMMENDED_BOT_SETTINGS,
  botGovernorSettings,
  botRiskLevel,
  botSettingsSchema,
  clampBotSettings,
  projectedActiveHoursPerDay,
  withRecommendedLimits,
  type BotSettings,
} from '../src/index.js';

/** Settings with no rest (24 h duty cycle) and a fixed day length, so each
 * factor can be pushed to a tier boundary on its own. */
function probe(opts: {
  hours?: number;
  delay?: number;
  searchesPerHour?: number;
  buysPerHour?: number;
}): BotSettings {
  return {
    ...DEFAULT_BOT_SETTINGS,
    searchDelay: { min: opts.delay ?? 8, max: (opts.delay ?? 8) + 1 },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    safety: {
      ...DEFAULT_BOT_SETTINGS.safety,
      maxActiveHoursPerDay: opts.hours ?? 10,
      maxSearchesPerHour: opts.searchesPerHour ?? 100,
      maxBuysPerHour: opts.buysPerHour ?? 5,
    },
  };
}

describe('bot settings — defaults and migration', () => {
  it('defaults to the recommended limits', () => {
    expect(DEFAULT_BOT_SETTINGS.searchDelay).toEqual({ min: 8, max: 12 });
    expect(DEFAULT_BOT_SETTINGS.rest).toEqual({
      enabled: true,
      afterMinutes: { min: 60, max: 60 },
      minutes: { min: 20, max: 20 },
    });
    expect(DEFAULT_BOT_SETTINGS.safety).toEqual({
      maxSearchesPerHour: 250,
      maxBuysPerHour: 15,
      maxActiveHoursPerDay: 6,
      maxCoinFlowPerHour: 500_000,
      cooldownSeconds: 10,
      buyToSearchRatio: 0.35,
    });
    expect(DEFAULT_BOT_SETTINGS.riskAcknowledgedAt).toBeNull();
    expect(botSettingsSchema.safeParse(DEFAULT_BOT_SETTINGS).success).toBe(true);
  });

  it('parses settings from older builds, filling only the missing fields', () => {
    // As the first Sniping Bot build stored them (and the safety-mode build).
    const old = {
      safetyMode: 'custom',
      customRiskAcknowledgedAt: '2026-09-24T08:00:00.000Z',
      searchDelay: { min: 3, max: 5 },
      breaks: { enabled: true, searches: { min: 15, max: 15 }, seconds: { min: 10, max: 10 } },
      rest: { enabled: true, afterMinutes: { min: 20, max: 30 }, minutes: { min: 15, max: 20 } },
      thresholds: { maxBuyPrice: 0, minProfit: 1_000, stopAfterPurchases: 0, sessionCoinBudget: 0 },
      safety: {
        actionsPerHour: 900,
        sessionLengthMinutes: 120,
        buyToSearchRatio: 0.35,
        cooldownSeconds: 120,
        maxCoinFlowPerHour: 2_000_000,
      },
    };
    const parsed = botSettingsSchema.parse(old);
    // Kept: what the user had set.
    expect(parsed.searchDelay).toEqual({ min: 3, max: 5 });
    expect(parsed.rest.afterMinutes).toEqual({ min: 20, max: 30 });
    expect(parsed.safety.cooldownSeconds).toBe(120);
    expect(parsed.safety.maxCoinFlowPerHour).toBe(2_000_000);
    // Filled: the new fields, from the recommended defaults.
    expect(parsed.safety.maxSearchesPerHour).toBe(250);
    expect(parsed.safety.maxBuysPerHour).toBe(15);
    expect(parsed.safety.maxActiveHoursPerDay).toBe(6);
    expect(parsed.riskAcknowledgedAt).toBeNull();
    // The engine never reads the legacy fields.
    expect(clampBotSettings(parsed)).not.toHaveProperty('safetyMode');
    expect(clampBotSettings(parsed).safety).not.toHaveProperty('actionsPerHour');
  });

  it('rejects inverted ranges and values outside BOT_LIMITS', () => {
    const bad = (patch: Partial<BotSettings>) =>
      botSettingsSchema.safeParse({ ...DEFAULT_BOT_SETTINGS, ...patch }).success;
    expect(bad({ searchDelay: { min: 5, max: 2 } })).toBe(false);
    expect(bad({ searchDelay: { min: 0.1, max: 2 } })).toBe(false);
    expect(bad({ safety: { ...DEFAULT_BOT_SETTINGS.safety, maxSearchesPerHour: 100_000 } })).toBe(
      false,
    );
    expect(bad({ safety: { ...DEFAULT_BOT_SETTINGS.safety, maxActiveHoursPerDay: 25 } })).toBe(
      false,
    );
  });

  it('clamps a tampered value into BOT_LIMITS for the engine', () => {
    const tampered = {
      ...DEFAULT_BOT_SETTINGS,
      searchDelay: { min: 0, max: -3 },
      safety: {
        ...DEFAULT_BOT_SETTINGS.safety,
        maxSearchesPerHour: 1e9,
        maxBuysPerHour: Number.NaN,
        maxActiveHoursPerDay: 100,
        cooldownSeconds: -5,
      },
    } as BotSettings;
    const c = clampBotSettings(tampered);
    expect(c.searchDelay).toEqual({ min: 0.5, max: 0.5 });
    expect(c.safety.maxSearchesPerHour).toBe(BOT_LIMITS.maxSearchesPerHour.max);
    expect(c.safety.maxBuysPerHour).toBe(RECOMMENDED_BOT_SETTINGS.safety.maxBuysPerHour);
    expect(c.safety.maxActiveHoursPerDay).toBe(24);
    expect(c.safety.cooldownSeconds).toBe(0);
    expect(botGovernorSettings(tampered).actionsPerHour).toBe(7_200 + 15);
  });

  it('resets to the recommended limits, keeping targets and thresholds', () => {
    const changed: BotSettings = {
      ...probe({ delay: 1, searchesPerHour: 3_000, buysPerHour: 200 }),
      thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, maxBuyPrice: 50_000 },
      riskAcknowledgedAt: '2026-09-24T08:00:00.000Z',
    };
    const reset = withRecommendedLimits(changed);
    expect(reset.searchDelay).toEqual(DEFAULT_BOT_SETTINGS.searchDelay);
    expect(reset.rest).toEqual(DEFAULT_BOT_SETTINGS.rest);
    expect(reset.safety).toEqual(DEFAULT_BOT_SETTINGS.safety);
    expect(reset.thresholds.maxBuyPrice).toBe(50_000);
    expect(reset.riskAcknowledgedAt).toBe('2026-09-24T08:00:00.000Z');
  });
});

describe('botRiskLevel', () => {
  it('rates the recommended defaults low', () => {
    const risk = botRiskLevel(DEFAULT_BOT_SETTINGS);
    // 60 on / 20 off = 18 h, capped at 6; 250 searches and 15 buys an hour.
    expect(projectedActiveHoursPerDay(DEFAULT_BOT_SETTINGS)).toBe(6);
    expect(risk).toEqual({
      level: 'low',
      reasons: [],
      projectedSearchesPerDay: 1_500,
      projectedBuysPerDay: 90,
    });
  });

  it('uses the session/rest duty cycle when it is below the daily cap', () => {
    const s: BotSettings = {
      ...DEFAULT_BOT_SETTINGS,
      safety: { ...DEFAULT_BOT_SETTINGS.safety, maxActiveHoursPerDay: 24 },
    };
    expect(projectedActiveHoursPerDay(s)).toBe(18); // 0.75 of the day
    expect(botRiskLevel(s).projectedSearchesPerDay).toBe(250 * 18);
  });

  it('caps searches per hour by the search delay', () => {
    // 3600 / 20 s = 180 an hour, under the 250 limit.
    const s = probe({ delay: 20, searchesPerHour: 250, hours: 10 });
    expect(botRiskLevel(s).projectedSearchesPerDay).toBe(1_800);
  });

  it('searches a day: 2,000 / 3,500 / 5,000 boundaries', () => {
    const at = (perHour: number, hours = 10) =>
      botRiskLevel(probe({ searchesPerHour: perHour, hours })).level;
    expect(at(200)).toBe('low'); // 2,000
    expect(at(201)).toBe('moderate'); // 2,010
    expect(at(350)).toBe('moderate'); // 3,500
    expect(at(351)).toBe('high'); // 3,510
    expect(at(250, 20)).toBe('high'); // 5,000
    expect(at(251, 20)).toBe('very_high'); // 5,020
    expect(botRiskLevel(probe({ searchesPerHour: 420, hours: 10 })).reasons).toEqual([
      'About 4,200 searches a day — above the ~3,500 moderate limit',
    ]);
  });

  it('buys a day: 100 / 150 / 250 boundaries', () => {
    const at = (perHour: number) => botRiskLevel(probe({ buysPerHour: perHour })).level;
    expect(at(10)).toBe('low'); // 100
    expect(at(11)).toBe('moderate'); // 110
    expect(at(15)).toBe('moderate'); // 150
    expect(at(16)).toBe('high'); // 160
    expect(at(25)).toBe('high'); // 250
    expect(at(26)).toBe('very_high'); // 260
    expect(botRiskLevel(probe({ buysPerHour: 12 })).reasons).toEqual([
      'About 120 buys a day — above the ~100 low limit',
    ]);
  });

  it('search delay: 6 / 4 / 2 second boundaries', () => {
    const at = (delay: number) => botRiskLevel(probe({ delay })).level;
    expect(at(6)).toBe('low');
    expect(at(5.9)).toBe('moderate');
    expect(at(4)).toBe('moderate');
    expect(at(3.9)).toBe('high');
    expect(at(2)).toBe('high');
    expect(at(1.9)).toBe('very_high');
    expect(botRiskLevel(probe({ delay: 3 })).reasons).toEqual([
      'Searches as little as 3 s apart — under the 4 s moderate minimum',
    ]);
  });

  it('takes the worst factor and lists every reason', () => {
    const risk = botRiskLevel(probe({ delay: 5, buysPerHour: 30, searchesPerHour: 100 }));
    expect(risk.level).toBe('very_high');
    expect(risk.reasons).toHaveLength(2);
  });
});
