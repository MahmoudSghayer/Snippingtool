/** The one categorical series palette every chart in the app draws from
 * (dataviz skill: "one visual system, consistent series colours"). Read at
 * call time (not module load) so it always reflects the live CSS custom
 * properties — safe under SSR-less Vite/CSR, which is this app's only
 * rendering mode. */
export function seriesColor(index: number): string {
  const varName = `--sl-chart-${(index % 6) + 1}`;
  const fallback = FALLBACK[((index % FALLBACK.length) + FALLBACK.length) % FALLBACK.length] ?? '#6fbf9b';
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

const FALLBACK: readonly string[] = ['#6fbf9b', '#ddb35c', '#7ea7e0', '#c993dd', '#e08678', '#8fd0c9'];

export const POSITIVE_COLOR = '#6fbf9b';
export const NEGATIVE_COLOR = '#e08678';
export const GRID_COLOR = '#242f2b';
export const AXIS_COLOR = '#94a49e';
