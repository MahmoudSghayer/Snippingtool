import { describe, expect, it } from 'vitest';

import {
  adapterActionResultMessageSchema,
  adapterActRequestMessageSchema,
  adapterProbeMessageSchema,
  backgroundMessageEnvelopeSchema,
  extBackgroundGovernorSnapshotPushPayloadSchema,
} from '../src/ext-messages.js';

// Regression: background/index.ts registers a 'governor.snapshotPush'/
// 'governor.snapshotGet' handler (popup live risk gauge — docs/10-design-
// system.md §15, docs/12-testing.md "Defects found"), but
// `backgroundMessageTypeSchema` (the envelope's `type` field) is a
// hand-maintained enum, separate from the handler table it gates — adding
// a handler without also adding it here means `background/index.ts`'s own
// `backgroundMessageEnvelopeSchema.safeParse(message)` silently rejects
// every real message of that type before it ever reaches the handler (no
// response, no log — `parsed.success` false short-circuits with a bare
// `return undefined`). Caught while writing this suite's cross-app e2e run
// (a real popup send of 'governor.snapshotGet' rejected at the envelope
// level, confirmed via direct SW console instrumentation) — this pins it
// so it can't silently regress the same way for any future message type.
describe('backgroundMessageEnvelopeSchema', () => {
  it('accepts governor.snapshotPush with a real snapshot payload', () => {
    const payload = extBackgroundGovernorSnapshotPushPayloadSchema.parse({
      actionsLastHour: 1,
      actionsPerHourLimit: 30,
      sessionElapsedMinutes: 1,
      sessionLengthLimitMinutes: 90,
      buyToSearchRatio: 0.1,
      buyToSearchRatioLimit: 0.35,
      coinFlowLastHour: 1000,
      coinFlowLimit: 300_000,
      inCooldown: false,
      cooldownRemainingMs: 0,
      killSwitchActive: false,
    });
    const result = backgroundMessageEnvelopeSchema.safeParse({ type: 'governor.snapshotPush', payload });
    expect(result.success).toBe(true);
  });

  it('accepts governor.snapshotGet with no payload', () => {
    const result = backgroundMessageEnvelopeSchema.safeParse({ type: 'governor.snapshotGet' });
    expect(result.success).toBe(true);
  });
});

describe('adapterActRequestMessageSchema', () => {
  it('accepts a search request', () => {
    const result = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'search', requestId: 'r1', filter: { minRating: 75 } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a buy request', () => {
    const result = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'buy', requestId: 'r2', tradeId: 't1', price: 1000 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown action', () => {
    const result = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'bid', requestId: 'r3' },
    });
    expect(result.success).toBe(false);
  });
});

describe('adapterActionResultMessageSchema', () => {
  it('is still valid without the additive requestId/stillListed fields', () => {
    const result = adapterActionResultMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'action_result',
      data: { action: 'buy', ok: true, requestedAt: 1, completedAt: 2 },
    });
    expect(result.success).toBe(true);
  });
});

describe('adapterProbeMessageSchema', () => {
  it('accepts a failing probe with a reason', () => {
    const result = adapterProbeMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'probe',
      data: { ok: false, checkedAt: Date.now(), reason: 'services.Item missing' },
    });
    expect(result.success).toBe(true);
  });
});
