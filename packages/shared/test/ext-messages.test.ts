import { describe, expect, it } from 'vitest';

import {
  adapterActionResultMessageSchema,
  adapterActRequestMessageSchema,
  adapterCatalogMessageSchema,
  adapterMessageSchema,
  adapterProbeMessageSchema,
  backgroundMessageEnvelopeSchema,
  extBackgroundEngineStateSetPayloadSchema,
  extBackgroundGovernorSnapshotPushPayloadSchema,
  extContentKillSwitchMessageSchema,
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
    const result = backgroundMessageEnvelopeSchema.safeParse({
      type: 'governor.snapshotPush',
      payload,
    });
    expect(result.success).toBe(true);
  });

  it('accepts governor.snapshotGet with no payload', () => {
    const result = backgroundMessageEnvelopeSchema.safeParse({ type: 'governor.snapshotGet' });
    expect(result.success).toBe(true);
  });

  // Regression (docs/12-testing.md "Defects found" row #10): the content
  // script's crash-recovery state now round-trips through background
  // instead of touching storage.session itself — both message types must be
  // accepted at the envelope, and the set payload must match what
  // `engine/governor.ts`'s `serialize()` produces.
  it('accepts engine.stateSet with a serialized governor state, and engine.stateGet with no payload', () => {
    const state = {
      sessionStartedAt: 1_000_000,
      actionTimestamps: [1_000_100, 1_000_200],
      searchCount: 2,
      buyCount: 0,
      coinFlow: [{ at: 1_000_200, coins: 1500 }],
      cooldownUntil: 0,
      killSwitchActive: false,
    };
    expect(
      backgroundMessageEnvelopeSchema.safeParse({ type: 'engine.stateSet', payload: state })
        .success,
    ).toBe(true);
    expect(extBackgroundEngineStateSetPayloadSchema.safeParse(state).success).toBe(true);
    expect(extBackgroundEngineStateSetPayloadSchema.safeParse({ ...state, extra: 1 }).success).toBe(
      false,
    );
    expect(backgroundMessageEnvelopeSchema.safeParse({ type: 'engine.stateGet' }).success).toBe(
      true,
    );
  });

  // Kill-switch propagation (docs/06-extension.md §5): the content script's
  // no-network pull is a payload-less background message; the push is a
  // background -> tab message with its own strict schema.
  it('accepts license.killSwitchGet with no payload', () => {
    expect(
      backgroundMessageEnvelopeSchema.safeParse({ type: 'license.killSwitchGet' }).success,
    ).toBe(true);
  });
});

describe('extContentKillSwitchMessageSchema (background -> EA tab)', () => {
  it('accepts an activation with a reason and a bare deactivation', () => {
    expect(
      extContentKillSwitchMessageSchema.safeParse({
        type: 'engine.killSwitch',
        payload: { active: true, reason: 'admin' },
      }).success,
    ).toBe(true);
    expect(
      extContentKillSwitchMessageSchema.safeParse({
        type: 'engine.killSwitch',
        payload: { active: false },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys, a wrong type, and a non-boolean flag', () => {
    expect(
      extContentKillSwitchMessageSchema.safeParse({
        type: 'engine.killSwitch',
        payload: { active: true, extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      extContentKillSwitchMessageSchema.safeParse({
        type: 'engine.stateGet',
        payload: { active: true },
      }).success,
    ).toBe(false);
    expect(
      extContentKillSwitchMessageSchema.safeParse({
        type: 'engine.killSwitch',
        payload: { active: 'yes' },
      }).success,
    ).toBe(false);
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

  it('rejects a buy at price 0 (a listing with no buy-now price)', () => {
    const result = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'buy', requestId: 'r4', tradeId: 't1', price: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a diagnostics request, which carries nothing but its id', () => {
    const ok = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'diagnostics', requestId: 'r5' },
    });
    expect(ok.success).toBe(true);
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

describe('adapter channel MACs (defect C10)', () => {
  const mac = 'ab'.repeat(32);

  it('accepts a hex HMAC-SHA256 on act requests and action results', () => {
    expect(
      adapterActRequestMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'act_request',
        data: { action: 'readResult', requestId: 'r1', tradeId: 't1' },
        mac,
      }).success,
    ).toBe(true);
    expect(
      adapterActionResultMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'action_result',
        data: {
          action: 'buy',
          requestId: 'r1',
          ok: false,
          error: 'price_mismatch',
          requestedAt: 1,
          completedAt: 2,
        },
        mac,
      }).success,
    ).toBe(true);
  });

  it('rejects a MAC that is not 64 lowercase hex characters', () => {
    for (const bad of ['', 'xyz', 'AB'.repeat(32), 'ab'.repeat(33)]) {
      expect(
        adapterActionResultMessageSchema.safeParse({
          channel: 'ledger:v2',
          kind: 'action_result',
          data: { action: 'buy', requestId: 'r1', ok: true, requestedAt: 1, completedAt: 2 },
          mac: bad,
        }).success,
      ).toBe(false);
    }
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
  it('accepts the actReady flag', () => {
    const result = adapterProbeMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'probe',
      data: { ok: true, checkedAt: 1, actReady: false },
    });
    expect(result.success && result.data.data.actReady).toBe(false);
  });

  it('accepts a failing probe with a reason', () => {
    const result = adapterProbeMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'probe',
      data: { ok: false, checkedAt: Date.now(), reason: 'services.Item missing' },
    });
    expect(result.success).toBe(true);
  });
});

describe('adapter diagnostics result', () => {
  const diagnostics = {
    probe: { ok: true, shape: 'observable', checkedAt: 1 },
    candidates: [
      { shape: 'observable', present: true },
      {
        shape: 'promise',
        present: false,
        reason: 'window.services.Item.repository.search is not a function',
      },
    ],
    servicesKeys: { Item: { searchTransferMarket: 'function', bid: 'function' } },
    globals: { UTSearchCriteriaDTO: 'undefined' },
    lastMarketResponse: {
      source: 'act:search',
      at: 2,
      shape: { success: 'boolean', data: { items: { '#array': 'array(1)' } } },
    },
    stats: { seen: 0, parsed: 1, failed: 0 },
    log: ['line'],
  };

  it('keeps every key of the report, so the MAC still verifies after parsing', () => {
    const result = adapterActionResultMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'action_result',
      data: {
        action: 'diagnostics',
        requestId: 'r1',
        ok: true,
        requestedAt: 1,
        completedAt: 2,
        diagnostics,
      },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.data.diagnostics).toEqual(diagnostics);
  });

  it('rejects a log longer than 50 lines', () => {
    const result = adapterActionResultMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'action_result',
      data: {
        action: 'diagnostics',
        requestId: 'r1',
        ok: true,
        requestedAt: 1,
        completedAt: 2,
        diagnostics: { ...diagnostics, log: Array.from({ length: 51 }, () => 'x') },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('catalog.save payload', () => {
  it("accepts EA's filter lists, including rarity id 0 (Common) and clubs keyed by league id", async () => {
    const { extBackgroundCatalogSavePayloadSchema } = await import('../src/ext-messages.js');
    const option = (id: number, label: string) => ({
      id,
      value: String(id),
      label,
      img: `https://www.ea.com/x/${id}.png`,
    });
    const payload = {
      players: [{ id: 158023, name: 'Messi', rating: 88 }],
      portrait: 'https://www.ea.com/x/portraits/{id}.png',
      levels: [{ id: 2, value: 'gold', label: 'Gold' }],
      rarities: [{ ...option(0, 'Common'), levels: true }],
      positions: [{ id: 130, value: '130', label: 'Defenders' }],
      playStyles: [option(250, 'Basic')],
      nations: [option(18, 'France')],
      leagues: [option(16, 'Ligue 1 (FRA 1)')],
      clubs: { '16': [option(73, 'Paris SG')] },
      capturedAt: 1,
    };
    expect(extBackgroundCatalogSavePayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      extBackgroundCatalogSavePayloadSchema.safeParse({ ...payload, clubs: { x: [] } }).success,
    ).toBe(false);
  });
});

describe('the Sniping Bot catalog on the adapter channel', () => {
  const MAC = 'a'.repeat(64);
  const catalog = {
    players: [{ id: 158023, name: 'Messi', rating: 88 }],
    levels: [{ id: 2, value: 'gold', label: 'Gold' }],
    rarities: [],
    positions: [],
    playStyles: [],
    nations: [{ id: 18, value: '18', label: 'France', img: 'https://www.ea.com/x/18.png' }],
    leagues: [],
    clubs: {},
    capturedAt: 1,
  };

  it('accepts a catalog act request, like every other act request', () => {
    const result = adapterActRequestMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'act_request',
      data: { action: 'catalog', requestId: 'r1' },
      mac: MAC,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a signed catalog message, and keeps every key the MAC covers', () => {
    const result = adapterMessageSchema.safeParse({
      channel: 'ledger:v2',
      kind: 'catalog',
      data: { catalog },
      mac: MAC,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.kind === 'catalog' && result.data.data.catalog).toEqual(
      catalog,
    );
  });

  it('requires the MAC on a catalog message', () => {
    expect(
      adapterCatalogMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'catalog',
        data: { catalog },
      }).success,
    ).toBe(false);
    expect(
      adapterCatalogMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'catalog',
        data: { catalog },
        mac: 'nope',
      }).success,
    ).toBe(false);
  });

  it('rejects a catalog with unknown keys or entries past the bounds', () => {
    const post = (c: unknown) =>
      adapterCatalogMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'catalog',
        data: { catalog: c },
        mac: MAC,
      }).success;
    expect(post({ ...catalog, script: 'x' })).toBe(false);
    expect(post({ ...catalog, nations: [{ id: 1, value: '1', label: 'x'.repeat(121) }] })).toBe(
      false,
    );
    expect(post({ ...catalog, notes: Array.from({ length: 51 }, () => 'n') })).toBe(false);
    expect(
      adapterCatalogMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'catalog',
        data: { catalog, extra: 1 },
        mac: MAC,
      }).success,
    ).toBe(false);
  });
});

describe('catalog image URLs (only https on an EA host)', () => {
  it('accepts EA hosts and refuses every other URL', async () => {
    const { isEaAssetUrl } = await import('../src/adapter-channel.js');
    for (const ok of [
      'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/x.png',
      'https://ea.com/x.png',
      'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/x',
      'https://media.contentapi.ea2.com/x.png',
      'https://www.easports.com/x.png',
      'https://www.ea.com/x/portraits/{id}.png',
    ])
      expect(isEaAssetUrl(ok)).toBe(true);
    for (const bad of [
      'http://www.ea.com/x.png',
      'https://www.ea.com.evil.example/x.png',
      'https://evilea.com/x.png',
      'https://www.ea.com:8443/x.png',
      'https://user:pw@www.ea.com/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/relative/x.png',
      '',
      null,
    ])
      expect(isEaAssetUrl(bad)).toBe(false);
  });

  it('rejects a catalog with an image or portrait off EA', () => {
    const base = {
      players: [],
      levels: [],
      rarities: [],
      positions: [],
      playStyles: [],
      nations: [],
      leagues: [],
      clubs: {},
      capturedAt: 1,
    };
    const post = (c: unknown) =>
      adapterCatalogMessageSchema.safeParse({
        channel: 'ledger:v2',
        kind: 'catalog',
        data: { catalog: c },
        mac: 'a'.repeat(64),
      }).success;
    expect(post({ ...base, portrait: 'https://www.ea.com/p/{id}.png' })).toBe(true);
    expect(post({ ...base, portrait: 'https://tracker.example/p/{id}.png' })).toBe(false);
    expect(
      post({
        ...base,
        nations: [{ id: 1, value: '1', label: 'x', img: 'https://evil.example/1.png' }],
      }),
    ).toBe(false);
  });
});

describe('automation message types', () => {
  it('are not in the core envelope, and are accepted where background registers them', async () => {
    const { AUTOMATION_BACKGROUND_MESSAGE_TYPES } = await import('../src/automation-messages.js');
    const { backgroundMessageEnvelopeSchemaFor, backgroundMessageTypeSchema } =
      await import('../src/ext-messages.js');
    for (const t of AUTOMATION_BACKGROUND_MESSAGE_TYPES) {
      expect(backgroundMessageTypeSchema.safeParse(t).success).toBe(false);
      expect(backgroundMessageEnvelopeSchema.safeParse({ type: t }).success).toBe(false);
    }
    const envelope = backgroundMessageEnvelopeSchemaFor(['counts', 'bot.settingsSet']);
    expect(envelope.safeParse({ type: 'bot.settingsSet', payload: {} }).success).toBe(true);
    expect(envelope.safeParse({ type: 'counts' }).success).toBe(true);
    expect(envelope.safeParse({ type: 'catalog.save' }).success).toBe(false);
    expect(envelope.safeParse({ type: '__proto__' }).success).toBe(false);
    expect(envelope.safeParse({ type: 'constructor' }).success).toBe(false);
  });

  it('bot.budgetSet carries a governor state and the hourly windows, nothing else', async () => {
    const { extBackgroundBotBudgetSetPayloadSchema } = await import('../src/ext-messages.js');
    const budget = {
      governor: {
        sessionStartedAt: 1,
        actionTimestamps: [2, 3],
        searchCount: 2,
        buyCount: 0,
        coinFlow: [],
        cooldownUntil: 0,
        killSwitchActive: false,
      },
      searchTimes: [2, 3],
      buyTimes: [],
    };
    expect(extBackgroundBotBudgetSetPayloadSchema.safeParse(budget).success).toBe(true);
    expect(extBackgroundBotBudgetSetPayloadSchema.safeParse({ ...budget, extra: 1 }).success).toBe(
      false,
    );
    expect(
      extBackgroundBotBudgetSetPayloadSchema.safeParse({ ...budget, searchTimes: [-1] }).success,
    ).toBe(false);
  });
});
