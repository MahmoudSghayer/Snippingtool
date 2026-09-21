/**
 * Formatter helpers shared by StatTile, DataTable cells and chart tooltips —
 * the single place every "how do we print a number" decision is made, so
 * coins/percentages/currency never drift between screens.
 */

const coinsFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** EA FC coins — always a whole number, thousands-separated, no currency
 * symbol. Sign is preserved (net profit can be negative). */
export function formatCoins(value: number): string {
  return coinsFormatter.format(Math.round(value));
}

/** A shorter form for tight spaces (StatTile, sparkline tooltips): 1.2M, 850K. */
export function formatCoinsCompact(value: number): string {
  return compactFormatter.format(value);
}

/** `0.734` -> `73.4%`. Values are expected in the 0–1 range (matches every
 * `@sl/shared` schema's rate fields), not 0–100. */
export function formatPercent(value: number): string {
  return percentFormatter.format(value);
}

/** Integer cents (the API's money unit — see docs/05-subscriptions.md) to a
 * USD display string, e.g. `1999` -> `$19.99`. */
export function formatCurrencyFromCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** A signed delta string for StatTile's trend indicator: `+12.4%` / `-3.1%`. */
export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${percentFormatter.format(value)}`;
}

export function formatDate(value: string | Date, opts: Intl.DateTimeFormatOptions = {}): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', ...opts }).format(date);
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatRelativeTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(diffSec) >= secondsInUnit || unit === 'second') {
      return rtf.format(Math.round(diffSec / secondsInUnit), unit);
    }
  }
  return rtf.format(0, 'second');
}
