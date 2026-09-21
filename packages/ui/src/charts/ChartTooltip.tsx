export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number; color?: string }[];
  valueFormatter?: (value: number) => string;
}

/** One tooltip component every chart wrapper shares, so hover formatting
 * (and the visual chrome) never drifts between chart types. */
export function ChartTooltip({ active, label, payload, valueFormatter }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[--sl-radius-sm] border border-[--sl-border] bg-[--sl-surface-2] px-3 py-2 text-xs shadow-xl">
      {label !== undefined && <div className="mb-1 font-medium text-[--sl-fg]">{label}</div>}
      <div className="flex flex-col gap-1">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-[--sl-fg-muted]">{entry.name}</span>
            <span className="ml-auto font-mono tabular-nums text-[--sl-fg]">
              {typeof entry.value === 'number' && valueFormatter
                ? valueFormatter(entry.value)
                : entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
