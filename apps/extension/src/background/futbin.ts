/*
 * futbin.ts — a card's current price on FUTBIN, for Nova AI's auto-sell
 * (`price.futbin`, automation builds only).
 *
 * FUTBIN publishes no API. This reads the JSON its own player pages load:
 *
 *   GET https://www.futbin.com/{year}/playerPrices?player={resourceId}
 *   -> { "<resourceId>": { "prices": { "ps": { "LCPrice": "12,500", ... },
 *                                      "pc": { "LCPrice": "13,000", ... } } } }
 *
 * where `ps` is the console market (PlayStation and Xbox share it) and
 * `LCPrice` the lowest current buy-now. FUTBIN can change or block this at
 * any time, so anything that does not read exactly like that, including a
 * price of 0, is "no price" (null), and auto-sell falls back to Nova's own
 * market data. A price is reused for a few minutes, so a bot buying the same
 * card again does not ask FUTBIN each time.
 */
import { externalFetch } from '../lib/http.js';

export type FutbinPlatform = 'console' | 'pc';

const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED = 500;
const cache = new Map<string, { at: number; price: number | null }>();

/** FUTBIN's path segment for the current game: a new FC comes out each
 * September, and FC 27's prices live under /27/. */
export function futbinYear(now: Date = new Date()): number {
  const yy = now.getUTCFullYear() % 100;
  return now.getUTCMonth() >= 8 ? yy + 1 : yy;
}

function readPrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,3}(,\d{3})*$|^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim().replace(/,/g, ''));
  return n > 0 ? n : null;
}

/** The lowest buy-now FUTBIN reports for `resourceId` on `platform`, or null. */
export function parseFutbinPrice(json: unknown, resourceId: number, platform: FutbinPlatform): number | null {
  const card = (json as Record<string, unknown> | null)?.[String(resourceId)] as
    | { prices?: Record<string, { LCPrice?: unknown } | undefined> }
    | undefined;
  const market = card?.prices?.[platform === 'pc' ? 'pc' : 'ps'];
  return readPrice(market?.LCPrice);
}

export async function handleFutbinPrice(payload: {
  resourceId: number;
  platform: FutbinPlatform;
}): Promise<{ price: number | null }> {
  const { resourceId, platform } = payload;
  const key = `${platform}:${resourceId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { price: hit.price };

  let price: number | null = null;
  try {
    const res = await externalFetch(
      `https://www.futbin.com/${futbinYear()}/playerPrices?player=${resourceId}`,
      { headers: { accept: 'application/json' } },
    );
    if (res.ok) price = parseFutbinPrice(JSON.parse(await res.text()), resourceId, platform);
  } catch {
    // Unreachable, blocked, or not JSON: no price.
  }
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, { at: Date.now(), price });
  return { price };
}
