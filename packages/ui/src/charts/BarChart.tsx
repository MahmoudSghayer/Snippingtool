import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartTooltip } from './ChartTooltip.js';
import { AXIS_COLOR, GRID_COLOR, seriesColor } from './palette.js';

import type { SeriesConfig } from './LineChart.js';

export interface BarChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesConfig[];
  valueFormatter?: (value: number) => string;
  stacked?: boolean;
  layout?: 'horizontal' | 'vertical';
}

export function BarChart({
  data,
  xKey,
  series,
  valueFormatter,
  stacked,
  layout = 'horizontal',
}: BarChartProps) {
  const vertical = layout === 'vertical';
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RBarChart data={data} layout={layout} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid
          stroke={GRID_COLOR}
          strokeDasharray="3 3"
          horizontal={!vertical}
          vertical={vertical}
        />
        {vertical ? (
          <>
            <XAxis
              type="number"
              stroke={AXIS_COLOR}
              fontSize={11}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              tickFormatter={valueFormatter}
            />
            <YAxis
              dataKey={xKey}
              type="category"
              stroke={AXIS_COLOR}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={100}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={xKey}
              stroke={AXIS_COLOR}
              fontSize={11}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
            />
            <YAxis
              stroke={AXIS_COLOR}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={valueFormatter}
            />
          </>
        )}
        <Tooltip
          content={<ChartTooltip valueFormatter={valueFormatter} />}
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={stacked ? '1' : undefined}
            fill={seriesColor(s.colorIndex ?? i)}
            radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            maxBarSize={36}
          />
        ))}
      </RBarChart>
    </ResponsiveContainer>
  );
}
