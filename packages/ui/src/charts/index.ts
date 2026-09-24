// The chart subset of the design system — split from the root barrel
// (`@sl/ui`) because Recharts alone is a ~188 KB-gzip chunk, and most routes
// (e.g. `/login`) never render a chart. Import these from `@sl/ui/charts`,
// never from `@sl/ui`, so pages that don't chart don't pay for Recharts.

export * from './palette.js';
export * from './ChartTooltip.js';
export * from './ChartLegend.js';
export * from './LineChart.js';
export * from './AreaChart.js';
export * from './BarChart.js';
export * from './DonutChart.js';
export * from './Sparkline.js';
