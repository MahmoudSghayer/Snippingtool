import { describe, expect, it } from 'vitest';

import {
  adapterActionResultMessageSchema,
  adapterActRequestMessageSchema,
  adapterProbeMessageSchema,
} from '../src/ext-messages.js';

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
