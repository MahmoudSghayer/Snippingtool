import {
  Area,
  AreaChart as RAreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartTooltip } from './ChartTooltip.js';
import { AXIS_COLOR, GRID_COLOR, seriesColor } from './palette.js';

import type { SeriesConfig } from './LineChart.js';

export interface AreaChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesConfig[];
  valueFormatter?: (value: number) => string;
  stacked?: boolean;
}

export function AreaChart({ data, xKey, series, valueFormatter, stacked }: AreaChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RAreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`sl-area-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={seriesColor(s.colorIndex ?? i)} stopOpacity={0.35} />
              <stop offset="95%" stopColor={seriesColor(s.colorIndex ?? i)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS_COLOR} fontSize={11} tickLine={false} axisLine={{ stroke: GRID_COLOR }} />
        <YAxis stroke={AXIS_COLOR} fontSize={11} tickLine={false} axisLine={false} width={48} tickFormatter={valueFormatter} />
        <Tooltip content={<ChartTooltip valueFormatter={valueFormatter} />} />
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId={stacked ? '1' : undefined}
            stroke={seriesColor(s.colorIndex ?? i)}
            strokeWidth={2}
            fill={`url(#sl-area-${s.key})`}
          />
        ))}
      </RAreaChart>
    </ResponsiveContainer>
  );
}
