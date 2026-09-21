// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
//
// Cross-cutting strictness coverage: every request-body schema this repo
// marks `.strict()` (docs/09-security.md "Input validation" calls this the
// mass-assignment defence — an unrecognised extra key must 400, never be
// silently stripped) actually rejects an unknown key, and every schema that
// bounds an array or a string with `.max()` actually rejects an oversize
// input. This complements the per-schema test files under
// `test/schemas/**`, which check business-rule validity; this file checks
// the "hostile extra/oversize input" edge that's easy to lose when a schema
// is edited later and a field gets added without `.strict()`/`.max()` kept
// in sync.
//
// A schema is only asserted against here if it is genuinely `.strict()` (or
// wraps `.array(...).max(n)`/`.string().max(n)`) in the source today — see
// each `describe` block's comment for the exact schema.
//
// Fixed finding: `activityIngestBatchSchema` (schemas/activity.ts) was the
// one batch-ingest envelope that was not `.strict()` — every sibling
// envelope (`reportTradesRequestSchema`, `reportSnipingAttemptsRequestSchema`,
// `reportFilterStatsRequestSchema`, `telemetryFlushRequestSchema`,
// `extensionErrorReportSchema`) already was. `.strict()` was added to it
// (and to its per-event `metadata` objects) — see docs/09-security.md
// "Input validation"; the `it.each` table below now covers it like every
// other request schema instead of via a separate "documents the bug"
// block.

import { describe, expect, it } from 'vitest';

import { activityIngestBatchSchema, searchActivitySchema } from '../src/schemas/activity.js';
import { adminActionRequestSchema, updateFeatureToggleRequestSchema } from '../src/schemas/admin.js';
import { deviceFingerprintSchema, loginRequestSchema, logoutRequestSchema, mfaVerifyRequestSchema, passwordResetConfirmSchema, registerRequestSchema } from '../src/schemas/auth.js';
import { bootstrapRequestSchema, telemetryFlushRequestSchema, extensionErrorReportSchema, telemetryEventSchema } from '../src/schemas/extension.js';
import { createSavedFilterRequestSchema, updateSavedFilterRequestSchema, filterCriteriaSchema, reportFilterStatsRequestSchema, filterStatsSchema } from '../src/schemas/filters.js';
import { createBanRequestSchema, liftBanRequestSchema, reviewFlagRequestSchema } from '../src/schemas/moderation.js';
import { updateUserSettingsRequestSchema, governorSettingsSchema, GOVERNOR_ABSOLUTE_LIMITS } from '../src/schemas/settings.js';
import { reportSnipingAttemptsRequestSchema, snipingAttemptSchema } from '../src/schemas/sniping.js';
import { reportTradesRequestSchema, tradeSchema } from '../src/schemas/trades.js';
import { updateProfileRequestSchema, adminSuspendUserRequestSchema, adminBanUserRequestSchema, changePasswordRequestSchema } from '../src/schemas/users.js';

const device = () => ({ fingerprint: 'a'.repeat(20) });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const isoNow = () => new Date().toISOString();

describe('strictness: unknown top-level keys are rejected (mass-assignment defence)', () => {
  it.each([
    ['registerRequestSchema', registerRequestSchema, { email: 'a@example.com', password: 'correcthorse1', device: device() }],
    ['loginRequestSchema', loginRequestSchema, { email: 'a@example.com', password: 'x', device: device() }],
    ['deviceFingerprintSchema', deviceFingerprintSchema, device()],
    ['mfaVerifyRequestSchema', mfaVerifyRequestSchema, { mfaTicket: 't', code: '123456' }],
    ['passwordResetConfirmSchema', passwordResetConfirmSchema, { token: 't', password: 'correcthorse1' }],
    ['logoutRequestSchema', logoutRequestSchema, { refreshToken: 't' }],
    ['updateProfileRequestSchema', updateProfileRequestSchema, { timezone: 'UTC' }],
    ['changePasswordRequestSchema', changePasswordRequestSchema, { currentPassword: 'a', newPassword: 'correcthorse1' }],
    ['adminSuspendUserRequestSchema', adminSuspendUserRequestSchema, { reason: 'because' }],
    ['adminBanUserRequestSchema', adminBanUserRequestSchema, { type: 'account', reason: 'because' }],
    ['adminActionRequestSchema', adminActionRequestSchema, { reason: 'because' }],
    ['updateFeatureToggleRequestSchema', updateFeatureToggleRequestSchema, { enabled: true }],
    ['createBanRequestSchema', createBanRequestSchema, { type: 'account', reason: 'because' }],
    ['liftBanRequestSchema', liftBanRequestSchema, { reason: 'because' }],
    ['reviewFlagRequestSchema', reviewFlagRequestSchema, { status: 'reviewed', reason: 'because' }],
    ['createSavedFilterRequestSchema', createSavedFilterRequestSchema, { name: 'My filter', filter: {} }],
    ['updateSavedFilterRequestSchema', updateSavedFilterRequestSchema, { name: 'x' }],
    ['filterCriteriaSchema', filterCriteriaSchema, { minPrice: 100 }],
    ['bootstrapRequestSchema', bootstrapRequestSchema, { device: device(), extensionVersion: '1.0.0', buildTarget: 'ledger' }],
    ['updateUserSettingsRequestSchema', updateUserSettingsRequestSchema, { telemetryOptOut: true }],
    [
      'activityIngestBatchSchema',
      activityIngestBatchSchema,
      { events: [{ type: 'heartbeat', occurredAt: isoNow(), metadata: { extensionVersion: '1.0.0' } }] },
    ],
  ] as const)('%s rejects an unrecognised extra key', (_name, schema, validBase) => {
    const withUnknownKey = { ...validBase, notARealField: 'sneaky' };
    const valid = schema.safeParse(validBase);
    expect(valid.success, `base fixture should itself be valid: ${JSON.stringify(valid.success ? {} : valid.error.issues)}`).toBe(true);

    const result = schema.safeParse(withUnknownKey);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('governorSettingsSchema (nested, itself strict) rejects an unrecognised key', () => {
    const valid = {
      actionsPerHour: 30,
      sessionLengthMinutes: 90,
      buyToSearchRatio: 0.35,
      cooldownSeconds: 20,
      maxCoinFlowPerHour: 300_000,
    };
    expect(governorSettingsSchema.safeParse(valid).success).toBe(true);
    expect(governorSettingsSchema.safeParse({ ...valid, extraKnob: 1 }).success).toBe(false);
  });

  it('updateUserSettingsRequestSchema rejects an unrecognised key nested inside a partial section', () => {
    const result = updateUserSettingsRequestSchema.safeParse({ targets: { minProfitPerSnipe: 1000, madeUpField: true } });
    expect(result.success).toBe(false);
  });

  it('tradeSchema (batch element) rejects an unrecognised key', () => {
    const valid = {
      id: uuid(1),
      tradeId: 't1',
      resourceId: 1,
      assetId: null,
      rating: 85,
      buyPrice: 1000,
      sellPrice: null,
      eaTax: 0.05,
      netProfit: null,
      status: 'bought',
      boughtAt: isoNow(),
      soldAt: null,
    };
    expect(tradeSchema.safeParse(valid).success).toBe(true);
    expect(tradeSchema.safeParse({ ...valid, hack: 1 }).success).toBe(false);
  });

  it('snipingAttemptSchema (batch element) rejects an unrecognised key', () => {
    const valid = {
      resourceId: 1,
      targetPrice: 1000,
      listedPrice: 1000,
      outcome: 'success',
      latencyMs: 100,
      errorCode: null,
      occurredAt: isoNow(),
      deviceId: uuid(2),
    };
    expect(snipingAttemptSchema.safeParse(valid).success).toBe(true);
    expect(snipingAttemptSchema.safeParse({ ...valid, hack: 1 }).success).toBe(false);
  });

  it('filterStatsSchema (batch element) rejects an unrecognised key', () => {
    const valid = { filterId: uuid(3), windowStart: isoNow(), searches: 1, attempts: 1, successes: 1, coinsSpent: 0, coinsEarned: 0, coinsPerHour: 0 };
    expect(filterStatsSchema.safeParse(valid).success).toBe(true);
    expect(filterStatsSchema.safeParse({ ...valid, hack: 1 }).success).toBe(false);
  });

  it('telemetryEventSchema (batch element) rejects an unrecognised key', () => {
    const valid = { name: 'popup.opened', occurredAt: isoNow() };
    expect(telemetryEventSchema.safeParse(valid).success).toBe(true);
    expect(telemetryEventSchema.safeParse({ ...valid, hack: 1 }).success).toBe(false);
  });
});

describe('strictness: batch envelopes reject an oversize array', () => {
  it('reportTradesRequestSchema caps trades at 200', () => {
    const one = { id: uuid(1), tradeId: 't', resourceId: 1, assetId: null, rating: null, buyPrice: 1, sellPrice: null, eaTax: 0, netProfit: null, status: 'bought' as const, boughtAt: isoNow(), soldAt: null };
    expect(reportTradesRequestSchema.safeParse({ trades: Array(200).fill(one) }).success).toBe(true);
    expect(reportTradesRequestSchema.safeParse({ trades: Array(201).fill(one) }).success).toBe(false);
    expect(reportTradesRequestSchema.safeParse({ trades: [] }).success).toBe(false); // min(1)
  });

  it('reportSnipingAttemptsRequestSchema caps attempts at 200', () => {
    const one = { resourceId: 1, targetPrice: 1, listedPrice: 1, outcome: 'success' as const, latencyMs: 1, errorCode: null, occurredAt: isoNow(), deviceId: uuid(2) };
    expect(reportSnipingAttemptsRequestSchema.safeParse({ attempts: Array(200).fill(one) }).success).toBe(true);
    expect(reportSnipingAttemptsRequestSchema.safeParse({ attempts: Array(201).fill(one) }).success).toBe(false);
  });

  it('reportFilterStatsRequestSchema caps stats at 200', () => {
    const one = { filterId: uuid(3), windowStart: isoNow(), searches: 0, attempts: 0, successes: 0, coinsSpent: 0, coinsEarned: 0, coinsPerHour: 0 };
    expect(reportFilterStatsRequestSchema.safeParse({ stats: Array(200).fill(one) }).success).toBe(true);
    expect(reportFilterStatsRequestSchema.safeParse({ stats: Array(201).fill(one) }).success).toBe(false);
  });

  it('telemetryFlushRequestSchema caps events at 500', () => {
    const one = { name: 'x', occurredAt: isoNow() };
    const base = { deviceId: uuid(4) };
    expect(telemetryFlushRequestSchema.safeParse({ ...base, events: Array(500).fill(one) }).success).toBe(true);
    expect(telemetryFlushRequestSchema.safeParse({ ...base, events: Array(501).fill(one) }).success).toBe(false);
  });

  it('extensionErrorReportSchema caps errors at 100 and rejects an oversize message/stack', () => {
    const one = { message: 'boom', occurredAt: isoNow() };
    const base = { deviceId: uuid(5), extensionVersion: '1.0.0' };
    expect(extensionErrorReportSchema.safeParse({ ...base, errors: Array(100).fill(one) }).success).toBe(true);
    expect(extensionErrorReportSchema.safeParse({ ...base, errors: Array(101).fill(one) }).success).toBe(false);

    expect(extensionErrorReportSchema.safeParse({ ...base, errors: [{ message: 'x'.repeat(2000), occurredAt: isoNow() }] }).success).toBe(true);
    expect(extensionErrorReportSchema.safeParse({ ...base, errors: [{ message: 'x'.repeat(2001), occurredAt: isoNow() }] }).success).toBe(false);
    expect(extensionErrorReportSchema.safeParse({ ...base, errors: [{ message: 'x', stack: 'y'.repeat(8001), occurredAt: isoNow() }] }).success).toBe(false);
  });

  it('activityIngestBatchSchema caps events at 500', () => {
    const one = { type: 'heartbeat' as const, occurredAt: isoNow(), metadata: { extensionVersion: '1.0.0' } };
    expect(activityIngestBatchSchema.safeParse({ events: Array(500).fill(one) }).success).toBe(true);
    expect(activityIngestBatchSchema.safeParse({ events: Array(501).fill(one) }).success).toBe(false);
  });
});

describe('strictness: oversize scalar fields are rejected at their documented .max()', () => {
  it('governorSettingsSchema rejects a value above each field\'s absolute ceiling', () => {
    const valid = { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 0.35, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 };
    expect(governorSettingsSchema.safeParse(valid).success).toBe(true);
    expect(governorSettingsSchema.safeParse({ ...valid, actionsPerHour: GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max + 1 }).success).toBe(false);
    expect(governorSettingsSchema.safeParse({ ...valid, sessionLengthMinutes: GOVERNOR_ABSOLUTE_LIMITS.sessionLengthMinutes.max + 1 }).success).toBe(false);
    expect(governorSettingsSchema.safeParse({ ...valid, maxCoinFlowPerHour: GOVERNOR_ABSOLUTE_LIMITS.maxCoinFlowPerHour.max + 1 }).success).toBe(false);
  });

  it('createSavedFilterRequestSchema rejects a name over 80 chars', () => {
    expect(createSavedFilterRequestSchema.safeParse({ name: 'x'.repeat(80), filter: {} }).success).toBe(true);
    expect(createSavedFilterRequestSchema.safeParse({ name: 'x'.repeat(81), filter: {} }).success).toBe(false);
  });

  it('adminSuspendUserRequestSchema rejects a reason over 1000 chars', () => {
    expect(adminSuspendUserRequestSchema.safeParse({ reason: 'x'.repeat(1000) }).success).toBe(true);
    expect(adminSuspendUserRequestSchema.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('deviceFingerprintSchema rejects an oversize fingerprint/name', () => {
    expect(deviceFingerprintSchema.safeParse({ fingerprint: 'a'.repeat(256) }).success).toBe(true);
    expect(deviceFingerprintSchema.safeParse({ fingerprint: 'a'.repeat(257) }).success).toBe(false);
    expect(deviceFingerprintSchema.safeParse({ fingerprint: 'a'.repeat(20), name: 'x'.repeat(121) }).success).toBe(false);
  });

  it('searchActivitySchema rejects an oversize filterHash', () => {
    const valid = { type: 'search' as const, occurredAt: isoNow(), metadata: { filterHash: 'a'.repeat(128), resultsCount: 0 } };
    expect(searchActivitySchema.safeParse(valid).success).toBe(true);
    expect(
      searchActivitySchema.safeParse({ ...valid, metadata: { ...valid.metadata, filterHash: 'a'.repeat(129) } }).success,
    ).toBe(false);
  });
});
