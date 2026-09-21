/** The one categorical series palette every chart in the app draws from
 * (dataviz skill: "one visual system, consistent series colours"). Read at
 * call time (not module load) so it always reflects the live CSS custom
 * properties — safe under SSR-less Vite/CSR, which is this app's only
 * rendering mode. */
export function seriesColor(index: number): string {
  const varName = `--sl-chart-${(index % 6) + 1}`;
  const fallback =
    FALLBACK[((index % FALLBACK.length) + FALLBACK.length) % FALLBACK.length] ?? '#6fbf9b';
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

const FALLBACK: readonly string[] = [
  '#35a87e',
  '#b96fd9',
  '#d9584a',
  '#2fa8ad',
  '#b9822a',
  '#4f7fd9',
];

// Pinned directly to chart-1 (green) / chart-3 (red), not resolved by index,
// so a future reorder of the categorical ramp (tokens.css) can never
// silently flip a profit/loss chart's polarity.
export const POSITIVE_COLOR = '#35a87e';
export const NEGATIVE_COLOR = '#d9584a';

/** `[{ key, label, colorIndex? }]` (a chart's own `series` prop) -> the
 * `ChartLegend` items with resolved colours, so every multi-series chart
 * builds its legend from the same array it already passes to the chart
 * instead of re-deriving colours by hand. */
export function seriesLegendItems(
  series: { key: string; label: string; colorIndex?: number }[],
): { key: string; label: string; color: string }[] {
  return series.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: seriesColor(s.colorIndex ?? i),
  }));
}
export const GRID_COLOR = '#242f2b';
export const AXIS_COLOR = '#94a49e';
