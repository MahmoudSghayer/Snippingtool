// Seeding the trade lifecycle from the account's open trades
// (lib/lifecycle-seed.ts, background/lifecycle.ts): when background asks
// `GET /api/v1/extension/open-trades`, how often, and that a card another
// browser bought then has its sale reported here on that buy's tradeId.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLifecycleSeeder, SEED_EVERY_MS, SEED_RETRY_MS } from '../../src/lib/lifecycle-seed.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { OpenTrade, OpenTradesResponse, Trade, TradePileItem } from '@sl/shared';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');

function openTrade(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    tradeId: '5001',
    itemId: '900001',
    resourceId: 50_331_700,
    rating: 88,
    buyPrice: 10_000,
    boughtAt: new Date(T0 - 3_600_000).toISOString(),
    ...overrides,
  };
}

function harness(answer: () => OpenTradesResponse | null | Promise<OpenTradesResponse | null>) {
  const clock = { now: T0 };
  const seeded: Array<{ trades: OpenTrade[]; complete: boolean | undefined }> = [];
  let stored = 0;
  const fetchOpenTrades = vi.fn(async () => answer());
  const seeder = createLifecycleSeeder({
    lifecycle: {
      seed: async (trades, options) => {
        seeded.push({ trades, complete: options?.complete });
        return trades.length;
      },
    },
    fetchOpenTrades,
    lastSeeded: { get: async () => stored, set: async (at) => void (stored = at) },
    now: () => clock.now,
  });
  return { seeder, seeded, fetchOpenTrades, clock, stored: () => stored };
}

describe('lib/lifecycle-seed.ts', () => {
  it('seeds, then not again until the last seed is older than asked', async () => {
    const h = harness(() => ({ items: [openTrade()], truncated: false }));
    expect(await h.seeder.run()).toBe(1);
    expect(h.seeded).toEqual([{ trades: [openTrade()], complete: true }]);
    expect(h.stored()).toBe(T0);

    h.clock.now += SEED_EVERY_MS - 1;
    expect(await h.seeder.run()).toBe(0);
    // A bot start only needs the last minute's.
    expect(await h.seeder.run(60_000)).toBe(1);
    h.clock.now += SEED_EVERY_MS;
    expect(await h.seeder.run()).toBe(1);
    expect(h.fetchOpenTrades).toHaveBeenCalledTimes(3);
  });

  it('asks once for callers arriving together', async () => {
    let release!: (value: OpenTradesResponse) => void;
    const h = harness(() => new Promise<OpenTradesResponse>((resolve) => (release = resolve)));
    const first = h.seeder.run(0);
    const second = h.seeder.run(0);
    await vi.waitFor(() => expect(h.fetchOpenTrades).toHaveBeenCalledTimes(1));
    release({ items: [openTrade()], truncated: false });
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(h.fetchOpenTrades).toHaveBeenCalledTimes(1);
  });

  it('waits before asking again after no answer (signed out, offline, refused), and never throws', async () => {
    let answer: OpenTradesResponse | null | 'throw' = null;
    const h = harness(() => {
      if (answer === 'throw') throw new Error('boom');
      return answer;
    });
    expect(await h.seeder.run()).toBe(0);
    h.clock.now += SEED_RETRY_MS - 1;
    answer = { items: [openTrade()], truncated: false };
    expect(await h.seeder.run()).toBe(0);
    expect(h.fetchOpenTrades).toHaveBeenCalledTimes(1);
    h.clock.now += 1;
    expect(await h.seeder.run()).toBe(1);

    answer = 'throw';
    expect(await h.seeder.run(0)).toBe(0);
  });

  it('keeps the last seed time across a restart, and a truncated list is not complete', async () => {
    const h = harness(() => ({ items: [openTrade()], truncated: true }));
    await h.seeder.run();
    expect(h.seeded[0]!.complete).toBe(false);

    // A restarted worker reads the stored time and does not ask again.
    const restarted = createLifecycleSeeder({
      lifecycle: { seed: async () => 1 },
      fetchOpenTrades: h.fetchOpenTrades,
      lastSeeded: { get: async () => h.stored(), set: async () => undefined },
      now: () => T0 + 60_000,
    });
    expect(await restarted.run()).toBe(0);
    expect(h.fetchOpenTrades).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('background/lifecycle.ts: seeding over the API', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function load() {
    const storage = await import('../../src/lib/storage.js');
    const telemetry = await import('../../src/lib/telemetry.js');
    const reported: Trade[] = [];
    vi.spyOn(telemetry, 'enqueue').mockImplementation(async (payload) => {
      if (payload.kind === 'trades') reported.push(...payload.items);
      return { queued: payload.items.length };
    });
    vi.spyOn(telemetry, 'whenPersisted').mockResolvedValue(undefined);
    const background = await import('../../src/background/lifecycle.js');
    return { storage, background, reported };
  }

  function openTradesAnswer(items: OpenTrade[]) {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/v1/extension/open-trades') ? jsonResponse(200, { items, truncated: false }) : jsonResponse(404, { code: 'NOT_FOUND', message: 'no' }),
    );
  }

  it("seeds before judging a trade pile, so another browser's buy has its sale reported on its tradeId", async () => {
    const { storage, background, reported } = await load();
    await storage.setSession('sl.accessToken', 'access-token');
    openTradesAnswer([openTrade({ tradeId: 'cross-5001', itemId: 'cross-900001' })]);

    const sold: TradePileItem = {
      itemId: 'cross-900001',
      tradeId: '7001',
      resourceId: 50_331_700,
      rating: 88,
      tradeState: 'closed',
      currentBid: 13_500,
      buyNowPrice: 14_000,
      expires: 0,
    };
    expect(await background.handleLifecyclePile({ items: [sold] })).toEqual({ reported: 1 });
    expect(reported).toEqual([
      expect.objectContaining({ tradeId: 'cross-5001', itemId: 'cross-900001', buyPrice: 10_000, sellPrice: 13_500, status: 'sold' }),
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.local/api/v1/extension/open-trades');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');

    // Read again only once the last read is 15 minutes old.
    expect(await background.seedOpenTrades()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while signed out', async () => {
    const { background } = await load();
    openTradesAnswer([openTrade({ tradeId: 'out-1', itemId: 'out-1' })]);
    expect(await background.seedOpenTrades(0)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the seed alarm re-reads only while the bot runs', async () => {
    const { storage, background } = await load();
    await storage.setSession('sl.accessToken', 'access-token');
    openTradesAnswer([openTrade({ tradeId: 'alarm-1', itemId: 'alarm-1' })]);
    await background.onLifecycleSeedAlarm();
    expect(fetchMock).not.toHaveBeenCalled();

    const { handleEngineState } = await import('../../src/background/engine-lease.js');
    expect(await handleEngineState({ engineState: 'running' })).toEqual({ ok: true, started: true });
    // Still running at the next push: not a new start.
    expect(await handleEngineState({ engineState: 'running' })).toEqual({ ok: true, started: false });
    await background.onLifecycleSeedAlarm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
