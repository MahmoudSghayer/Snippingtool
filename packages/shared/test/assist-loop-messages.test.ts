// The messages the assist loop (P0 Task 13) adds between the extension's
// content script, background and popup: the per-profile engine lease, the
// real engine state for the heartbeat, "New session", the assist hotkeys,
// and the extra numbers the session meters carry.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ASSIST_HOTKEYS,
  assistHotkeysSchema,
  backgroundMessageEnvelopeSchema,
  extBackgroundEngineLockPayloadSchema,
  extBackgroundEngineStatePayloadSchema,
  extBackgroundEngineStateSetPayloadSchema,
  extBackgroundGovernorSnapshotPushPayloadSchema,
  extContentResetSessionMessageSchema,
  trimmedAuctionSchema,
} from '../src/ext-messages.js';

const OWNER = '6f1c1d5e-8a8b-4d7e-9c52-3b7f1d2a9e10';

describe('the new background message types', () => {
  it.each([
    'engine.lockAcquire',
    'engine.lockRelease',
    'engine.resetSession',
    'lifecycle.todayPnl',
  ])('accepts %s at the envelope', (type) => {
    expect(backgroundMessageEnvelopeSchema.safeParse({ type }).success).toBe(true);
  });
});

describe('engine lease payload', () => {
  it('carries one owner id and nothing else', () => {
    expect(extBackgroundEngineLockPayloadSchema.safeParse({ ownerId: OWNER }).success).toBe(true);
    expect(extBackgroundEngineLockPayloadSchema.safeParse({ ownerId: 'tab-1' }).success).toBe(
      false,
    );
    expect(
      extBackgroundEngineLockPayloadSchema.safeParse({ ownerId: OWNER, expiresAt: 1 }).success,
    ).toBe(false);
  });
});

describe('engine.state payload (the heartbeat engine state)', () => {
  it('accepts the four states and nothing else', () => {
    for (const engineState of ['idle', 'running', 'paused', 'halted'])
      expect(extBackgroundEngineStatePayloadSchema.safeParse({ engineState }).success).toBe(true);
    expect(extBackgroundEngineStatePayloadSchema.safeParse({ engineState: 'on' }).success).toBe(
      false,
    );
    expect(
      extBackgroundEngineStatePayloadSchema.safeParse({ engineState: 'idle', x: 1 }).success,
    ).toBe(false);
  });
});

describe('engine.resetSession (background -> EA tab)', () => {
  it('is a bare, strict message', () => {
    expect(
      extContentResetSessionMessageSchema.safeParse({ type: 'engine.resetSession' }).success,
    ).toBe(true);
    expect(
      extContentResetSessionMessageSchema.safeParse({ type: 'engine.resetSession', payload: {} })
        .success,
    ).toBe(false);
    expect(
      extContentResetSessionMessageSchema.safeParse({ type: 'engine.killSwitch' }).success,
    ).toBe(false);
  });
});

describe('session meter numbers', () => {
  const snapshot = {
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
  };

  it('the pushed snapshot may carry the session spend and budget', () => {
    expect(
      extBackgroundGovernorSnapshotPushPayloadSchema.safeParse({
        ...snapshot,
        sessionCoinsSpent: 5_000,
        sessionCoinBudget: 100_000,
      }).success,
    ).toBe(true);
    expect(
      extBackgroundGovernorSnapshotPushPayloadSchema.safeParse({
        ...snapshot,
        sessionCoinBudget: null,
      }).success,
    ).toBe(true);
    expect(
      extBackgroundGovernorSnapshotPushPayloadSchema.safeParse({
        ...snapshot,
        sessionCoinsSpent: -1,
      }).success,
    ).toBe(false);
  });

  it('the saved governor state may carry the session spend', () => {
    const state = {
      sessionStartedAt: 1,
      actionTimestamps: [],
      searchCount: 0,
      buyCount: 0,
      coinFlow: [],
      cooldownUntil: 0,
      killSwitchActive: false,
    };
    expect(
      extBackgroundEngineStateSetPayloadSchema.safeParse({ ...state, sessionCoinsSpent: 10 })
        .success,
    ).toBe(true);
  });
});

describe('assist hotkeys', () => {
  it('ships Alt+B to buy and Alt+Up/Down to move the selection', () => {
    expect(DEFAULT_ASSIST_HOTKEYS.buy).toBe('Alt+KeyB');
    expect(DEFAULT_ASSIST_HOTKEYS.selectUp).toBe('Alt+ArrowUp');
    expect(DEFAULT_ASSIST_HOTKEYS.selectDown).toBe('Alt+ArrowDown');
    expect(assistHotkeysSchema.safeParse(DEFAULT_ASSIST_HOTKEYS).success).toBe(true);
  });

  it.each([
    'Enter',
    'Space',
    'ArrowUp',
    'KeyB',
    'Shift+KeyB',
    'Shift+Enter',
    'Alt+',
    'Alt+Key B',
    'Alt+Alt+KeyB',
  ])('refuses %s: EA’s own keys, and chords that type or repeat a modifier', (chord) => {
    expect(assistHotkeysSchema.safeParse({ ...DEFAULT_ASSIST_HOTKEYS, buy: chord }).success).toBe(
      false,
    );
  });

  it('accepts other Alt, Ctrl or Meta chords', () => {
    for (const chord of ['Ctrl+Alt+KeyK', 'Meta+Digit1', 'Alt+Shift+KeyB'])
      expect(assistHotkeysSchema.safeParse({ ...DEFAULT_ASSIST_HOTKEYS, buy: chord }).success).toBe(
        true,
      );
  });

  it('refuses one chord bound to two actions, and unknown keys', () => {
    expect(
      assistHotkeysSchema.safeParse({
        ...DEFAULT_ASSIST_HOTKEYS,
        selectUp: DEFAULT_ASSIST_HOTKEYS.buy,
      }).success,
    ).toBe(false);
    expect(
      assistHotkeysSchema.safeParse({ ...DEFAULT_ASSIST_HOTKEYS, extra: 'Alt+KeyX' }).success,
    ).toBe(false);
  });
});

describe('a listing may carry the card name from its item data', () => {
  const listing = {
    tradeId: 't1',
    resourceId: 1,
    assetId: 1,
    rating: 85,
    buyNow: 1000,
    startingBid: 0,
    currentBid: 0,
    offers: 0,
    expiresAt: null,
    seenAt: 0,
  };
  it('bounded to 80 characters', () => {
    expect(trimmedAuctionSchema.parse({ ...listing, name: 'Kylian Mbappé' }).name).toBe(
      'Kylian Mbappé',
    );
    expect(trimmedAuctionSchema.safeParse({ ...listing, name: 'x'.repeat(81) }).success).toBe(
      false,
    );
  });
});
