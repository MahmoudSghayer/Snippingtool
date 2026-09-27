// Coin amounts as traders type them: `60k`, `1.2m`, `60,000`. Shared so the
// dashboard's "Record sale" form and the extension read a typed price the
// same way.

import { MAX_COIN_PRICE } from './schemas/ingest-bounds.js';

/** EA's lowest Buy Now price. A sale recorded by hand below this is a typo
 * (a dropped `k`), not a real sale. */
export const MIN_SALE_PRICE = 200;

const SUFFIX: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 };

// Digits with optional thousands grouping (`1,250,000`, never `60,00`),
// an optional decimal part, and an optional k/m suffix.
const COINS_RE = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?([km]?)$/;

/** Whole coins from a typed amount, or `null` when it isn't one: not a
 * number, negative, or a fraction of a coin (`1.2345k`, `12.5`). */
export function parseCoins(input: string): number | null {
  const compact = input.trim().toLowerCase().replace(/\s+/g, '');
  const match = COINS_RE.exec(compact);
  if (!match) return null;
  const [, whole = '', fraction = '', suffix = ''] = match;
  if (whole === '' && fraction === '') return null;

  const amount = Number(`${whole.replace(/,/g, '') || '0'}.${fraction || '0'}`);
  const exact = amount * SUFFIX[suffix]!;
  const coins = Math.round(exact);
  // 1.2 * 1e6 is 1199999.9999999998 in floating point; a genuine fraction
  // of a coin is off by at least 0.001.
  if (Math.abs(exact - coins) > 1e-6) return null;
  return coins;
}

export type SalePriceResult = { ok: true; coins: number } | { ok: false; error: string };

/** `parseCoins` plus the transfer market's price bounds, with the message
 * to show the trader when the price is rejected. */
export function parseSalePrice(input: string): SalePriceResult {
  const coins = parseCoins(input);
  if (coins === null) return { ok: false, error: 'Enter a price like 60k, 1.2m or 60,000.' };
  if (coins < MIN_SALE_PRICE) return { ok: false, error: 'The lowest sale price is 200 coins.' };
  if (coins > MAX_COIN_PRICE)
    return { ok: false, error: 'The highest sale price is 15,000,000 coins.' };
  return { ok: true, coins };
}

/** A sale that loses more than half of what the card cost: worth a second
 * look before recording, since it's usually a missing digit. */
export function isHeavyLoss(buyPrice: number, netProfit: number): boolean {
  return netProfit < 0 && -netProfit > buyPrice / 2;
}
