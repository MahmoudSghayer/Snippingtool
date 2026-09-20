import { Line, LineChart, ResponsiveContainer } from 'recharts';

export interface SparklineProps {
  data: number[];
  color?: string;
}

/** Minimal trend indicator for StatTile — no axes/grid/tooltip by design
 * (dataviz skill: "no chart junk" — a sparkline's only job is shape). */
export function Sparkline({ data, color = '#6fbf9b' }: SparklineProps) {
  const points = data.map((value, i) => ({ i, value }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points}>
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
