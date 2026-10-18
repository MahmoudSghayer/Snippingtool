// How the Sniping Bot (engine/sniper.ts) reacts to EA's own errors, which
// the adapter now reports as `ea_error` messages instead of "market
// payload shape changed" (main/adapter.ts). Production: one EA error ended
// the session with a misleading "no auctionInfo array in response" reason.
// Now an expired session or a captcha stops the bot saying what to do, a
// rate limit or an outage makes it back off (5 s, 10 s, 20 s ... up to 2
// minutes, starting over after a clean search) and never stops it, and
// nothing EA says about the trade pile stops or slows it.
//
// The adapter posts the `ea_error` before the failed search's own (signed,
// so asynchronously delivered) result, and this fake does the same.

import { DEFAULT_BOT_SETTINGS, type AdapterEaError, type BotSettings, type TrimmedAuction } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Sniper, type SniperDeps } from '../../src/engine/sniper.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';

/** What one search does: EA errors the adapter reports while it runs, and
 * the search's own outcome. */
interface SearchScript {
  eaErrors?: Omit<AdapterEaError, 'seenAt'>[];
  shape?: { reason: string; endpoint: 'market' | 'pile' };
  outcome?: ActionOutcome;
  /** Listings the search finds (all under the filter's max price). */
  listings?: TrimmedAuction[];
  /** An EA error every buy in this search gets. */
  buyEaError?: Omit<AdapterEaError, 'seenAt'>;
}

const RATE_LIMITED = { status: 429, category: 'rate_limited', endpoint: 'market' } as const;
const FAILED: ActionOutcome = { ok: false, error: 'search reported success: false', latencyMs: 5 };
const OK: ActionOutcome = { ok: true, latencyMs: 5 };

function listing(tradeId: string, buyNow: number): TrimmedAuction {
  return { tradeId, resourceId: 100, assetId: 100, rating: 85, buyNow, startingBid: 0, currentBid: 0, offers: 0, expiresAt: null, seenAt: 0 };
}

function setup(script: (n: number) => SearchScript, opts: { maxSearches: number }) {
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
    riskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
  };
  const clock = { t: 1_000_000 };
  const searchTimes: number[] = [];
  const buys: string[] = [];
  const phases: string[] = [];
  let step: SearchScript = {};
  const listeners = {
    auctions: new Set<(a: TrimmedAuction[]) => void>(),
    shape: new Set<(reason: string, endpoint: 'market' | 'pile') => void>(),
    eaError: new Set<(e: AdapterEaError) => void>(),
  };
  const subscribe =
    <T>(set: Set<T>) =>
    (cb: T) => {
      set.add(cb);
      return () => set.delete(cb);
    };
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));

  const deps: SniperDeps = {
    adapter: {
      search: async () => {
        searchTimes.push(clock.t);
        step = script(searchTimes.length);
        for (const e of step.eaErrors ?? []) for (const cb of listeners.eaError) cb({ ...e, seenAt: clock.t });
        if (step.shape) for (const cb of listeners.shape) cb(step.shape.reason, step.shape.endpoint);
        const outcome = step.outcome ?? OK;
        if (outcome.ok) for (const cb of listeners.auctions) cb(step.listings ?? []);
        return outcome;
      },
      buy: async (tradeId) => {
        buys.push(tradeId);
        const e = step.buyEaError;
        if (!e) return { ok: true, latencyMs: 5 };
        for (const cb of listeners.eaError) cb({ ...e, seenAt: clock.t });
        return { ok: false, signed: true, error: `bid reported success: false (status ${e.status})`, latencyMs: 5 };
      },
      list: async () => ({ ok: true, latencyMs: 5 }),
      onAuctions: subscribe(listeners.auctions),
      onBuyable: () => () => undefined,
      onProbe: () => () => undefined,
      onShape: subscribe(listeners.shape),
      onEaError: subscribe(listeners.eaError),
    },
    getFilters: () => [{ id: 'f1', name: 'Target', filter: { resourceId: 100, maxPrice: 10_000 } }],
    estimateSellPrice: async () => null,
    killSwitch: () => ({ active: false }),
    onChange: () => {
      if (sniper.state.phase === 'stopped') finished();
    },
    now: () => clock.t,
    random: () => 0,
    sleep: async (ms) => {
      phases.push(sniper.state.phase);
      clock.t += ms;
      if (searchTimes.length >= opts.maxSearches && sniper.isRunning()) sniper.stop('manual');
      await Promise.resolve();
    },
  };
  const sniper = new Sniper(deps, settings);
  /** Time between one search and the next, in seconds. */
  const gaps = () => searchTimes.slice(1).map((t, i) => (t - searchTimes[i]!) / 1000);
  const log = () => sniper.getLog().map((e) => e.message);
  return { sniper, done: () => done, gaps, phases, log, searchTimes, buys };
}

describe('Sniper — EA errors', () => {
  it('stops with what to do when EA says the session ended (401)', async () => {
    const h = setup(() => ({ eaErrors: [{ status: 401, category: 'session_ended', endpoint: 'market' }], outcome: FAILED }), { maxSearches: 10 });
    h.sniper.start();
    await h.done();
    expect(h.searchTimes).toHaveLength(1);
    expect(h.sniper.state).toMatchObject({
      stopReason: 'ea_session_ended',
      stopDetail: 'Your EA session ended — log in to the web app again',
    });
  });

  it('stops with what to do when EA wants a verification (458), on a buy as on a search', async () => {
    const h = setup(() => ({ eaErrors: [{ status: 458, category: 'verification', endpoint: 'bid' }] }), { maxSearches: 10 });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state).toMatchObject({
      stopReason: 'ea_verification',
      stopDetail: 'EA wants a verification (captcha) — solve it in the web app, then Start again',
    });
  });

  it('backs off 5 s, 10 s, 20 s ... up to 2 minutes while EA rate-limits, and never stops for it', async () => {
    const h = setup(() => ({ eaErrors: [RATE_LIMITED], outcome: FAILED }), { maxSearches: 9 });
    h.sniper.start();
    await h.done();
    // Nine failed searches in a row: well past the five that stop the bot
    // for any other failure, and it only stopped because the test did.
    expect(h.searchTimes).toHaveLength(9);
    expect(h.sniper.state.stopReason).toBe('manual');
    expect(h.gaps()).toEqual([5, 10, 20, 40, 80, 120, 120, 120]);
    expect(h.phases).toContain('backoff');
    expect(h.log()).toContain('EA is limiting requests (HTTP 429): waiting 5 s before the next search');
  });

  it('starts the backoff over after a clean search', async () => {
    const h = setup((n) => (n === 4 ? {} : { eaErrors: [RATE_LIMITED], outcome: FAILED }), { maxSearches: 7 });
    h.sniper.start();
    await h.done();
    // 5 s, 10 s, 20 s, then search 4 is clean: the normal 1 s delay, and
    // the next error waits 5 s again.
    expect(h.gaps()).toEqual([5, 10, 20, 1, 5, 10]);
  });

  it('backs off on EA server errors too, and on a rate-limited buy', async () => {
    const h = setup(
      (n) =>
        n === 1
          ? { eaErrors: [{ status: 503, category: 'server_error', endpoint: 'market' }], outcome: FAILED }
          : n === 2
            ? { eaErrors: [{ status: 512, category: 'rate_limited', endpoint: 'bid' }] }
            : {},
      { maxSearches: 3 },
    );
    h.sniper.start();
    await h.done();
    expect(h.gaps()).toEqual([5, 10]);
    expect(h.log()).toContain('EA had a server error (HTTP 503): waiting 5 s before the next search');
  });

  it('stops buying the rest of a search once EA rate-limits a buy', async () => {
    const rateLimitedBuy = { status: 429, category: 'rate_limited', endpoint: 'bid' } as const;
    const listings = [listing('t1', 9_000), listing('t2', 9_100), listing('t3', 9_200)];
    const h = setup((n) => (n === 1 ? { listings, buyEaError: rateLimitedBuy } : {}), { maxSearches: 2 });
    h.sniper.start();
    await h.done();
    // One bid, not three: the other two would only have added to the limit.
    expect(h.buys).toEqual(['t1']);
    expect(h.gaps()).toEqual([5]);
  });

  it("backs off on EA's status in a failed search's error when no ea_error came", async () => {
    const h = setup(() => ({ outcome: { ok: false, error: 'search reported success: false (status 521)', latencyMs: 5 } }), { maxSearches: 7 });
    h.sniper.start();
    await h.done();
    expect(h.searchTimes).toHaveLength(7);
    expect(h.gaps()).toEqual([5, 10, 20, 40, 80, 120]);
  });

  it('still stops after five failed searches in a row that were not EA slowing it down', async () => {
    const h = setup(() => ({ outcome: { ok: false, error: 'timed out waiting for adapter response', latencyMs: 15_000 } }), { maxSearches: 10 });
    h.sniper.start();
    await h.done();
    expect(h.searchTimes).toHaveLength(5);
    expect(h.sniper.state.stopReason).toBe('search_failing');
  });

  it('never stops or slows down for anything EA says about the trade pile', async () => {
    const h = setup(
      () => ({
        eaErrors: [
          { status: 401, category: 'session_ended', endpoint: 'pile' },
          { status: 458, category: 'verification', endpoint: 'pile' },
          { status: 512, category: 'rate_limited', endpoint: 'pile' },
        ],
        shape: { reason: 'trade pile: no auctionInfo / itemData list in response', endpoint: 'pile' },
      }),
      { maxSearches: 4 },
    );
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('manual');
    expect(h.gaps()).toEqual([1, 1, 1]);
  });

  it('leaves a refused buy (someone else got it first) to the buy itself', async () => {
    const h = setup(() => ({ eaErrors: [{ status: 403, category: 'rejected', endpoint: 'bid' }] }), { maxSearches: 3 });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('manual');
    expect(h.gaps()).toEqual([1, 1]);
  });

  it('still stops on a real change in the market data shape', async () => {
    const h = setup(() => ({ shape: { reason: 'no auctionInfo array in response', endpoint: 'market' } }), { maxSearches: 10 });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state).toMatchObject({ stopReason: 'shape_mismatch', stopDetail: 'no auctionInfo array in response' });
  });
});
