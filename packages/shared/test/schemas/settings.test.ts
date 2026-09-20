import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GOVERNOR_SETTINGS,
  DEFAULT_NOTIFICATION_PREFS,
  GOVERNOR_ABSOLUTE_LIMITS,
  governorSettingsSchema,
  userSettingsSchema,
} from '../../src/schemas/settings.js';

describe('governorSettingsSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(governorSettingsSchema.safeParse(DEFAULT_GOVERNOR_SETTINGS).success).toBe(true);
  });

  it('rejects an actionsPerHour above the absolute ceiling', () => {
    const result = governorSettingsSchema.safeParse({
      ...DEFAULT_GOVERNOR_SETTINGS,
      actionsPerHour: GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a buyToSearchRatio of 0 (must be a positive minimum)', () => {
    const result = governorSettingsSchema.safeParse({
      ...DEFAULT_GOVERNOR_SETTINGS,
      buyToSearchRatio: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('userSettingsSchema', () => {
  it('accepts a full, well-formed settings document', () => {
    const result = userSettingsSchema.safeParse({
      version: 1,
      targets: { minProfitPerSnipe: 1000, dailyProfitGoal: 50_000 },
      budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: 1_000_000 },
      governor: DEFAULT_GOVERNOR_SETTINGS,
      telemetryOptOut: false,
      notifications: DEFAULT_NOTIFICATION_PREFS,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative minProfitPerSnipe', () => {
    const result = userSettingsSchema.safeParse({
      version: 1,
      targets: { minProfitPerSnipe: -1, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: null },
      governor: DEFAULT_GOVERNOR_SETTINGS,
      telemetryOptOut: false,
      notifications: DEFAULT_NOTIFICATION_PREFS,
    });
    expect(result.success).toBe(false);
  });
});
