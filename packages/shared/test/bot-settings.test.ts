import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_SETTINGS,
  SAFETY_PRESETS,
  botRiskLevel,
  botSettingsSchema,
  estimatedSearchesPerHour,
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
