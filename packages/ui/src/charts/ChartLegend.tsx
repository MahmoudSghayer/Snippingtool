/** A static legend row for any chart with >= 2 series (dataviz skill: "a
 * legend is always present for >= 2 series; none for one — identity is never
 * color-alone"). Deliberately outside Recharts' own `<Legend>` (which
 * reads series names off SVG paint order and re-renders on every hover) so
 * every chart wrapper (Line/Area/Bar) can share one plain, stable, styled
 * row and keyboard focus never has to enter the chart canvas to read it. */
export interface ChartLegendItem {
  key: string;
  label: string;
  color: string;
}

export interface ChartLegendProps {
  items: ChartLegendItem[];
  className?: string;
}

export function ChartLegend({ items, className }: ChartLegendProps) {
  if (items.length < 2) return null;
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${className ?? ''}`}>
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-xs text-[--sl-fg-muted]">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
