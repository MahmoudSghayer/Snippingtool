import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_SETTINGS,
  DEFAULT_GOVERNOR_SETTINGS,
  GOVERNOR_ABSOLUTE_LIMITS,
  SAFETY_PRESETS,
  botRiskLevel,
  botSettingsSchema,
  effectiveBotSettings,
  effectiveSafetyMode,
  estimatedSearchesPerHour,
  recommendedCaps,
  searchDelayPresets,
  withSafetyMode,
  type BotSettings,
} from '../src/index.js';

const noPauses = (delay: { min: number; max: number }): BotSettings => ({
  ...DEFAULT_BOT_SETTINGS,
  searchDelay: delay,
  breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
  rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
  safety: { ...SAFETY_PRESETS.high, actionsPerHour: 7_200 },
});

describe('bot settings', () => {
  it('accepts the defaults and every safety preset', () => {
    expect(botSettingsSchema.safeParse(DEFAULT_BOT_SETTINGS).success).toBe(true);
    for (const safety of Object.values(SAFETY_PRESETS)) {
      expect(botSettingsSchema.safeParse({ ...DEFAULT_BOT_SETTINGS, safety }).success).toBe(true);
    }
  });

  it('lets users go well past the server-synced governor limits', () => {
    const risky = {
      ...noPauses({ min: 0.5, max: 1 }),
      safety: { ...SAFETY_PRESETS.high, actionsPerHour: 7_200 },
    };
    expect(botSettingsSchema.safeParse(risky).success).toBe(true);
  });

  it('rejects inverted ranges and out-of-bounds values', () => {
    expect(
      botSettingsSchema.safeParse({ ...DEFAULT_BOT_SETTINGS, searchDelay: { min: 5, max: 2 } })
        .success,
    ).toBe(false);
    expect(
      botSettingsSchema.safeParse({ ...DEFAULT_BOT_SETTINGS, searchDelay: { min: 0.1, max: 2 } })
        .success,
    ).toBe(false);
    expect(
      botSettingsSchema.safeParse({
        ...DEFAULT_BOT_SETTINGS,
        safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 2 },
      }).success,
    ).toBe(false);
  });

  it('estimates pace and rates risk from it, capped by actions per hour', () => {
    expect(estimatedSearchesPerHour(noPauses({ min: 2, max: 2 }))).toBe(1_800);
    expect(botRiskLevel(noPauses({ min: 2, max: 2 }))).toBe('high');
    expect(botRiskLevel(noPauses({ min: 20, max: 20 }))).toBe('low');
    expect(
      botRiskLevel({ ...noPauses({ min: 2, max: 2 }), safety: { ...SAFETY_PRESETS.low } }),
    ).toBe('medium');
  });
});

describe('bot settings — safety mode', () => {
  /** Settings as a build without the safety switch saved them. */
  const legacy: Record<string, unknown> = { ...DEFAULT_BOT_SETTINGS };
  delete legacy.safetyMode;
  delete legacy.customRiskAcknowledgedAt;

  it('defaults to recommended, and reads settings saved before the field existed as recommended', () => {
    expect(DEFAULT_BOT_SETTINGS.safetyMode).toBe('recommended');
    const parsed = botSettingsSchema.parse(legacy);
    expect(parsed.safetyMode).toBe('recommended');
    expect(parsed.customRiskAcknowledgedAt).toBeNull();
    expect(parsed.safety).toEqual(DEFAULT_BOT_SETTINGS.safety);
  });

  it('reads an unknown mode or a malformed acknowledgment as recommended', () => {
    const parsed = botSettingsSchema.parse({
      ...legacy,
      safetyMode: 'yolo',
      customRiskAcknowledgedAt: 'yesterday',
    });
    expect(parsed.safetyMode).toBe('recommended');
    expect(parsed.customRiskAcknowledgedAt).toBeNull();
  });

  it('only counts custom mode once the risk was acknowledged', () => {
    expect(effectiveSafetyMode({ safetyMode: 'custom', customRiskAcknowledgedAt: null })).toBe(
      'recommended',
    );
    expect(
      effectiveSafetyMode({
        safetyMode: 'custom',
        customRiskAcknowledgedAt: '2026-09-24T08:00:00.000Z',
      }),
    ).toBe('custom');
  });

  it('turning custom mode on requires the acknowledgment and records when', () => {
    expect(() => withSafetyMode(DEFAULT_BOT_SETTINGS, 'custom')).toThrow(/acknowledgment/);
    expect(() => withSafetyMode(DEFAULT_BOT_SETTINGS, 'custom', { acknowledged: false })).toThrow();
    const now = new Date('2026-09-24T08:00:00.000Z');
    const on = withSafetyMode(DEFAULT_BOT_SETTINGS, 'custom', { acknowledged: true, now });
    expect(on.safetyMode).toBe('custom');
    expect(on.customRiskAcknowledgedAt).toBe('2026-09-24T08:00:00.000Z');
    expect(botSettingsSchema.parse(on)).toEqual(on);
    const off = withSafetyMode(on, 'recommended');
    expect(off.safetyMode).toBe('recommended');
    expect(off.customRiskAcknowledgedAt).toBeNull();
  });

  it('recommended mode clamps a tampered stored value to the governor caps', () => {
    const tampered: BotSettings = {
      ...noPauses({ min: 0.5, max: 0.5 }),
      safety: {
        actionsPerHour: 7_200,
        sessionLengthMinutes: 1_440,
        buyToSearchRatio: 1,
        cooldownSeconds: 0,
        maxCoinFlowPerHour: 1_000_000_000,
      },
    };
    expect(botSettingsSchema.safeParse(tampered).success).toBe(true);
    const eff = effectiveBotSettings(tampered, DEFAULT_GOVERNOR_SETTINGS);
    expect(eff.mode).toBe('recommended');
    expect(eff.safety).toEqual(DEFAULT_GOVERNOR_SETTINGS);
    expect(eff.minSearchDelaySeconds).toBeCloseTo(162);
    expect(eff.searchDelay.min).toBeCloseTo(162);
    // The pace the bot can reach is inside the cap.
    expect(estimatedSearchesPerHour(eff)).toBeLessThanOrEqual(eff.safety.actionsPerHour);
  });

  it('keeps the user value when it is already tighter than the cap', () => {
    const tight: BotSettings = {
      ...DEFAULT_BOT_SETTINGS,
      searchDelay: { min: 400, max: 500 },
      safety: { ...DEFAULT_BOT_SETTINGS.safety, actionsPerHour: 10, cooldownSeconds: 600 },
    };
    const eff = effectiveBotSettings(tight, DEFAULT_GOVERNOR_SETTINGS);
    expect(eff.safety.actionsPerHour).toBe(10);
    expect(eff.safety.cooldownSeconds).toBe(600);
    // 3600 * 1.35 / 10 = 486 s
    expect(eff.searchDelay.min).toBeCloseTo(486);
    expect(eff.searchDelay.max).toBe(500);
  });

  it('never trusts a governor cache past GOVERNOR_ABSOLUTE_LIMITS', () => {
    expect(
      recommendedCaps({
        actionsPerHour: 100_000,
        sessionLengthMinutes: Number.NaN,
        buyToSearchRatio: 3,
        cooldownSeconds: -1,
        maxCoinFlowPerHour: 1e12,
      }),
    ).toEqual({
      actionsPerHour: GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max,
      sessionLengthMinutes: DEFAULT_GOVERNOR_SETTINGS.sessionLengthMinutes,
      buyToSearchRatio: GOVERNOR_ABSOLUTE_LIMITS.buyToSearchRatio.max,
      cooldownSeconds: GOVERNOR_ABSOLUTE_LIMITS.cooldownSeconds.min,
      maxCoinFlowPerHour: GOVERNOR_ABSOLUTE_LIMITS.maxCoinFlowPerHour.max,
    });
    expect(recommendedCaps(null)).toEqual(DEFAULT_GOVERNOR_SETTINGS);
  });

  it('acknowledged custom mode applies the user limits within BOT_LIMITS', () => {
    const custom = withSafetyMode(
      { ...noPauses({ min: 0.5, max: 1 }), safety: { ...SAFETY_PRESETS.high } },
      'custom',
      { acknowledged: true },
    );
    const eff = effectiveBotSettings(custom, DEFAULT_GOVERNOR_SETTINGS);
    expect(eff.mode).toBe('custom');
    expect(eff.safety).toEqual(SAFETY_PRESETS.high);
    expect(eff.searchDelay).toEqual({ min: 0.5, max: 1 });
  });

  it('derives the recommended presets from the caps, all inside them, none called risky', () => {
    for (const governor of [
      DEFAULT_GOVERNOR_SETTINGS,
      { ...DEFAULT_GOVERNOR_SETTINGS, actionsPerHour: 120, buyToSearchRatio: 0.2 },
    ]) {
      const eff = effectiveBotSettings(DEFAULT_BOT_SETTINGS, governor);
      const presets = searchDelayPresets('recommended', eff.minSearchDelaySeconds);
      expect(presets.map((p) => p.label)).toEqual(['Careful', 'Balanced', 'Fastest allowed']);
      for (const p of presets) {
        expect(p.label).not.toMatch(/risk/i);
        expect(p.tone).not.toBe('risky');
        expect(p.min).toBeGreaterThanOrEqual(eff.minSearchDelaySeconds);
        const paced = noPauses({ min: p.min, max: p.max });
        expect(estimatedSearchesPerHour(paced)).toBeLessThanOrEqual(governor.actionsPerHour);
        const withPreset = { ...DEFAULT_BOT_SETTINGS, searchDelay: { min: p.min, max: p.max } };
        expect(botSettingsSchema.safeParse(withPreset).success).toBe(true);
      }
    }
    expect(searchDelayPresets('custom', 0.5).map((p) => p.label)).toEqual([
      'Risky',
      'Medium',
      'Safe',
    ]);
  });
});
