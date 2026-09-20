import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { ChartTooltip } from './ChartTooltip.js';
import { seriesColor } from './palette.js';

export interface DonutDatum {
  key: string;
  label: string;
  value: number;
  colorIndex?: number;
}

export interface DonutChartProps {
  data: DonutDatum[];
  valueFormatter?: (value: number) => string;
  centerLabel?: string;
  centerValue?: string;
}

export function DonutChart({ data, valueFormatter, centerLabel, centerValue }: DonutChartProps) {
  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%" paddingAngle={2} strokeWidth={0}>
            {data.map((d, i) => (
              <Cell key={d.key} fill={seriesColor(d.colorIndex ?? i)} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip valueFormatter={valueFormatter} />} />
        </PieChart>
      </ResponsiveContainer>
      {(centerLabel || centerValue) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {centerValue && <div className="font-mono text-lg font-semibold tabular-nums text-[--sl-fg]">{centerValue}</div>}
          {centerLabel && <div className="text-xs text-[--sl-fg-muted]">{centerLabel}</div>}
        </div>
      )}
    </div>
  );
}
