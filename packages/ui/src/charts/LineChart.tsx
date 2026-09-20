import {
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartTooltip } from './ChartTooltip.js';
import { AXIS_COLOR, GRID_COLOR, seriesColor } from './palette.js';

export interface SeriesConfig {
  key: string;
  label: string;
  colorIndex?: number;
}

export interface LineChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesConfig[];
  valueFormatter?: (value: number) => string;
}

export function LineChart({ data, xKey, series, valueFormatter }: LineChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RLineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS_COLOR} fontSize={11} tickLine={false} axisLine={{ stroke: GRID_COLOR }} />
        <YAxis stroke={AXIS_COLOR} fontSize={11} tickLine={false} axisLine={false} width={48} tickFormatter={valueFormatter} />
        <Tooltip content={<ChartTooltip valueFormatter={valueFormatter} />} />
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={seriesColor(s.colorIndex ?? i)}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
  );
}
