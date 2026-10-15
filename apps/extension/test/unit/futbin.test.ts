// background/futbin.ts: auto-sell's FUTBIN price. FUTBIN has no public API,
// so anything that does not read exactly like its player-prices JSON is "no
// price", and a price is reused for a few minutes.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { futbinYear, handleFutbinPrice, parseFutbinPrice } from '../../src/background/futbin.js';
import { setFetchImpl } from '../../src/lib/http.js';

const body = (prices: Record<string, unknown>) => ({ '231747': { prices } });

afterEach(() => {
  setFetchImpl((input, init) => fetch(input, init));
  vi.useRealTimers();
});

describe('parseFutbinPrice', () => {
  it('reads the lowest buy-now for the platform', () => {
    const json = body({ ps: { LCPrice: '1,250,000' }, pc: { LCPrice: '1,300,000' } });
    expect(parseFutbinPrice(json, 231747, 'console')).toBe(1_250_000);
    expect(parseFutbinPrice(json, 231747, 'pc')).toBe(1_300_000);
  });

  it('is null for anything else', () => {
    expect(parseFutbinPrice(body({ ps: { LCPrice: '0' } }), 231747, 'console')).toBeNull();
    expect(parseFutbinPrice(body({ ps: { LCPrice: 'N/A' } }), 231747, 'console')).toBeNull();
    expect(parseFutbinPrice(body({ ps: {} }), 231747, 'console')).toBeNull();
    expect(parseFutbinPrice(body({ ps: { LCPrice: '1,250' } }), 999, 'console')).toBeNull();
    expect(parseFutbinPrice('<html>Just a moment...</html>', 231747, 'console')).toBeNull();
    expect(parseFutbinPrice(null, 231747, 'console')).toBeNull();
  });
});

describe('futbinYear', () => {
  it("moves to the next game's prices each September", () => {
    expect(futbinYear(new Date('2026-08-31T12:00:00Z'))).toBe(26);
    expect(futbinYear(new Date('2026-09-01T12:00:00Z'))).toBe(27);
    expect(futbinYear(new Date('2027-01-15T12:00:00Z'))).toBe(27);
  });
});

describe('handleFutbinPrice', () => {
  it("asks this game's FUTBIN prices, and reuses the answer for a few minutes", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T07:00:00Z'));
    const urls: string[] = [];
    setFetchImpl(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ '501': { prices: { ps: { LCPrice: '12,500' } } } }), { status: 200 });
    });
    expect(await handleFutbinPrice({ resourceId: 501, platform: 'console' })).toEqual({ price: 12_500 });
    expect(await handleFutbinPrice({ resourceId: 501, platform: 'console' })).toEqual({ price: 12_500 });
    expect(urls).toEqual(['https://www.futbin.com/27/playerPrices?player=501']);
  });

  it('is null when FUTBIN fails, blocks, or answers something else', async () => {
    setFetchImpl(async () => new Response('<html>blocked</html>', { status: 200 }));
    expect(await handleFutbinPrice({ resourceId: 502, platform: 'pc' })).toEqual({ price: null });
    setFetchImpl(async () => new Response('', { status: 403 }));
    expect(await handleFutbinPrice({ resourceId: 503, platform: 'pc' })).toEqual({ price: null });
    setFetchImpl(async () => {
      throw new TypeError('network error');
    });
    expect(await handleFutbinPrice({ resourceId: 504, platform: 'pc' })).toEqual({ price: null });
  });
});
