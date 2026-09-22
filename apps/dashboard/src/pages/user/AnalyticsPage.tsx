import {
  AreaChart,
  BarChart,
  Card,
  CardContent,
  ChartCard,
  ChartLegend,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  EmptyState,
  formatCoins,
  FormField,
  PageHeader,
  Select,
  seriesLegendItems,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client.js';

import type { ActivityAnalyticsPoint, FilterStats } from '@sl/shared';

const snipeOutcomeSeries = [
  { key: 'snipeAttempts', label: 'Attempts', colorIndex: 1 },
  { key: 'snipeSuccesses', label: 'Successes', colorIndex: 0 },
];

const activityColumns: ColumnDef<ActivityAnalyticsPoint, unknown>[] = [
  { accessorKey: 'bucket', header: 'Date' },
  { accessorKey: 'logins', header: 'Logins' },
  { accessorKey: 'searches', header: 'Searches' },
  { accessorKey: 'filterChanges', header: 'Filter changes' },
  { accessorKey: 'snipeAttempts', header: 'Snipe attempts' },
  { accessorKey: 'snipeSuccesses', header: 'Snipe successes' },
  { accessorKey: 'errors', header: 'Errors' },
];

const filterStatsColumns: ColumnDef<FilterStats, unknown>[] = [
  {
    accessorKey: 'windowStart',
    header: 'Window',
    cell: (c) => new Date(c.getValue() as string).toLocaleDateString(),
  },
  { accessorKey: 'searches', header: 'Searches' },
  { accessorKey: 'attempts', header: 'Attempts' },
  { accessorKey: 'successes', header: 'Successes' },
  {
    accessorKey: 'coinsSpent',
    header: 'Coins spent',
    cell: (c) => formatCoins(c.getValue() as number),
  },
  {
    accessorKey: 'coinsEarned',
    header: 'Coins earned',
    cell: (c) => formatCoins(c.getValue() as number),
  },
  {
    accessorKey: 'coinsPerHour',
    header: 'Coins/hour',
    cell: (c) => formatCoins(c.getValue() as number),
  },
];

/** `/analytics/me/{profits,activity}` — profit series, snipe outcomes and
 * activity, per PHASE 7. Filter performance uses `GET /filters/stats`
 * (docs/07-dashboard.md §11 gap #5) — the ranker's realised-return history
 * per saved filter. */
export function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));
  const [filterId, setFilterId] = useState<string | undefined>(undefined);

  const filtersQuery = useQuery({
    queryKey: ['filters'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/filters');
      if (error) throw error;
      return data;
    },
  });

  const filterStatsQuery = useQuery({
    queryKey: ['filters', 'stats', filterId, range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/filters/stats', {
        params: {
          query: { filterId, from: `${range.from}T00:00:00.000Z`, to: `${range.to}T23:59:59.999Z` },
        },
      });
      if (error) throw error;
      return data;
    },
  });

  const profitsQuery = useQuery({
    queryKey: ['analytics', 'me', 'profits', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/profits', {
        params: { query: { ...range, granularity: 'day' } },
      });
      if (error) throw error;
      return data;
    },
  });

  const activityQuery = useQuery({
    queryKey: ['analytics', 'me', 'activity', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/activity', {
        params: { query: { ...range, granularity: 'day', tz: 'UTC' } },
      });
      if (error) throw error;
      return data;
    },
  });

  const profitItems = profitsQuery.data?.items ?? [];
  const activityItems = activityQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Profit, snipe outcomes and activity over time."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      <ChartCard
        title="Net profit"
        description="Daily net coin profit for the selected range."
        isLoading={profitsQuery.isLoading}
        isEmpty={!profitsQuery.isLoading && !profitsQuery.isError && profitItems.length === 0}
        emptyMessage={
          profitsQuery.isError
            ? "Couldn't load profit analytics."
            : 'No profit recorded for this range.'
        }
      >
        <AreaChart
          data={profitItems}
          xKey="bucket"
          series={[{ key: 'netProfit', label: 'Net profit', colorIndex: 0 }]}
          valueFormatter={formatCoins}
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Snipe outcomes"
          description="Attempts vs. successes per day."
          legend={<ChartLegend items={seriesLegendItems(snipeOutcomeSeries)} />}
          isLoading={activityQuery.isLoading}
          isEmpty={!activityQuery.isLoading && !activityQuery.isError && activityItems.length === 0}
          emptyMessage={
            activityQuery.isError
              ? "Couldn't load activity analytics."
              : 'No snipe activity for this range.'
          }
        >
          <BarChart data={activityItems} xKey="bucket" series={snipeOutcomeSeries} />
        </ChartCard>

        <ChartCard
          title="Coins traded"
          description="Total coins moved per day (buy + sell)."
          isLoading={profitsQuery.isLoading}
          isEmpty={!profitsQuery.isLoading && !profitsQuery.isError && profitItems.length === 0}
        >
          <BarChart
            data={profitItems}
            xKey="bucket"
            series={[{ key: 'coinsTraded', label: 'Coins traded', colorIndex: 2 }]}
            valueFormatter={formatCoins}
          />
        </ChartCard>
      </div>

      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity log</TabsTrigger>
          <TabsTrigger value="filters">Filter performance</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <Card>
            <CardContent className="pt-5">
              <DataTable
                columns={activityColumns}
                data={activityItems}
                isLoading={activityQuery.isLoading}
                isError={activityQuery.isError}
                errorMessage="Couldn't load activity analytics."
                onRetry={() => void activityQuery.refetch()}
                emptyTitle="No activity in this range"
                getRowId={(row) => row.bucket}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="filters">
          {(filtersQuery.data ?? []).length === 0 && !filtersQuery.isLoading ? (
            <Card>
              <CardContent className="pt-5">
                <EmptyState
                  title="No saved filters yet"
                  description="Save a filter in the extension to start tracking its realised coins/hour here."
                />
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              <FormField label="Filter" htmlFor="filter-select" className="w-64">
                <Select
                  value={filterId ?? ''}
                  onValueChange={(v) => setFilterId(v || undefined)}
                  options={[
                    { value: '', label: 'All filters' },
                    ...(filtersQuery.data ?? []).map((f) => ({ value: f.id, label: f.name })),
                  ]}
                />
              </FormField>

              <ChartCard
                title="Coins per hour"
                description="Realised return per window for the selected filter."
                isLoading={filterStatsQuery.isLoading}
                isEmpty={
                  !filterStatsQuery.isLoading &&
                  !filterStatsQuery.isError &&
                  (filterStatsQuery.data ?? []).length === 0
                }
                emptyMessage={
                  filterStatsQuery.isError
                    ? "Couldn't load filter performance."
                    : 'No stats reported for this range yet.'
                }
              >
                <AreaChart
                  data={[...(filterStatsQuery.data ?? [])].reverse()}
                  xKey="windowStart"
                  series={[{ key: 'coinsPerHour', label: 'Coins/hour', colorIndex: 0 }]}
                  valueFormatter={formatCoins}
                />
              </ChartCard>

              <Card>
                <CardContent className="pt-5">
                  <DataTable
                    columns={filterStatsColumns}
                    data={filterStatsQuery.data ?? []}
                    isLoading={filterStatsQuery.isLoading}
                    isError={filterStatsQuery.isError}
                    onRetry={() => void filterStatsQuery.refetch()}
                    emptyTitle="No stats reported for this range yet"
                    getRowId={(row) => `${row.filterId}-${row.windowStart}`}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default AnalyticsPage;
