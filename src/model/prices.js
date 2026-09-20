/*
 * prices.js — turning sightings into the three numbers that decide a trade.
 *
 * Everything here is deliberately simple statistics over observed listings. No
 * model fitting, no ML. With a few days of data the percentiles alone beat a
 * crowd-sourced price, and a simple estimator you can reason about is worth
 * more than an accurate-looking one you can't.
 */

export const EA_TAX = 0.05;

/** An auction is only evidence of a *price* while it is actually listed. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

/*
 * Did this auction sell, or did it run out the clock?
 *
 * We can't observe a sale directly. What we can observe is that an auction
 * stopped appearing in results well before its own expiry. That is a decent
 * proxy for "someone bought it" and a poor one for anything else.
 *
 * Known bias, stated so nobody trusts this more than it deserves: we only see
 * auctions that match searches you actually ran, so an auction can vanish from
 * our view because you stopped searching, not because it sold. GRACE_MS and the
 * coverage check below blunt that; they do not remove it. Treat sell-through as
 * a comparative signal between cards, not an absolute rate.
 */
const GRACE_MS = 3 * 60 * 1000;

function classify(row, coverageEnd, nowMs) {
  if (!row.expiresAt) return 'unknown';
  // Still on the clock: nothing has happened to it yet.
  if (row.expiresAt > nowMs) return 'still-live';
  // It ran out after we stopped watching this card, so we never saw the ending.
  if (row.expiresAt > coverageEnd) return 'unknown';
  if (row.lastSeen < row.expiresAt - GRACE_MS) return 'likely-sold';
  return 'likely-expired';
}

/**
 * Summarise one card.
 *
 * @param {Array} rows   auctions from db.auctionsForResource()
 * @param {number} nowMs
 */
export function summarise(rows, nowMs = Date.now()) {
  const empty = {
    listings: 0, floor: null, p10: null, median: null,
    sellThrough: null, sold: 0, expired: 0, sample: 0, tax: EA_TAX
  };
  if (!rows || rows.length === 0) return empty;

  const bins = rows.map((r) => r.buyNow).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

  // We only "covered" the market up to the last time we saw anything at all.
  const coverageEnd = rows.reduce((max, r) => (r.lastSeen > max ? r.lastSeen : max), 0);

  let sold = 0;
  let expired = 0;
  for (const r of rows) {
    const verdict = classify(r, coverageEnd, nowMs);
    if (verdict === 'likely-sold') sold++;
    else if (verdict === 'likely-expired') expired++;
  }

  const decided = sold + expired;

  return {
    listings: rows.length,
    floor: bins.length ? bins[0] : null,
    p10: percentile(bins, 0.10),
    median: percentile(bins, 0.50),
    sellThrough: decided >= 5 ? sold / decided : null, // below 5 it's noise, so say nothing
    sold,
    expired,
    sample: decided,
    freshnessMs: nowMs - coverageEnd,
    tax: EA_TAX
  };
}

/**
 * What a snipe at `price` is actually worth.
 *
 * Sells at the median rather than the floor: undercutting the floor is how you
 * sell fast, but the median is what the card is worth. Both are shown so you
 * can pick.
 */
export function margin(summary, price) {
  if (!summary || summary.median == null || !Number.isFinite(price) || price <= 0) return null;
  const netAtMedian = Math.round(summary.median * (1 - EA_TAX)) - price;
  const netAtFloor = summary.floor == null ? null : Math.round(summary.floor * (1 - EA_TAX)) - price;
  return {
    netAtMedian,
    netAtFloor,
    // Expected value needs the odds of actually shifting it, not just the spread.
    expected: summary.sellThrough == null ? null : Math.round(netAtMedian * summary.sellThrough)
  };
}

/** The highest price at which a snipe still clears `minProfit` coins. */
export function maxSnipePrice(summary, minProfit) {
  if (!summary || summary.median == null) return null;
  return Math.max(0, Math.round(summary.median * (1 - EA_TAX)) - minProfit);
}
