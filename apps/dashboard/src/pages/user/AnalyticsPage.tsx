import {
  AreaChart,
  BarChart,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartCard,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  EmptyState,
  formatCoins,
  PageHeader,
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

import type { ActivityAnalyticsPoint } from '@sl/shared';


const activityColumns: ColumnDef<ActivityAnalyticsPoint, unknown>[] = [
  { accessorKey: 'bucket', header: 'Date' },
  { accessorKey: 'logins', header: 'Logins' },
  { accessorKey: 'searches', header: 'Searches' },
  { accessorKey: 'filterChanges', header: 'Filter changes' },
  { accessorKey: 'snipeAttempts', header: 'Snipe attempts' },
  { accessorKey: 'snipeSuccesses', header: 'Snipe successes' },
  { accessorKey: 'errors', header: 'Errors' },
];

/** `/analytics/me/{profits,activity}` — profit series, snipe outcomes and
 * activity, per PHASE 7. Filter-performance (`filter_stats`) has no GET
 * endpoint anywhere in the API yet (only the extension's ingest `POST
 * /filters/stats`) — documented as a follow-up in docs/07-dashboard.md
 * rather than faked here. */
export function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));

  const profitsQuery = useQuery({
    queryKey: ['analytics', 'me', 'profits', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/profits', { params: { query: { ...range, granularity: 'day' } } });
      if (error) throw error;
      return data;
    },
  });

  const activityQuery = useQuery({
    queryKey: ['analytics', 'me', 'activity', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/activity', { params: { query: { ...range, granularity: 'day', tz: 'UTC' } } });
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
        emptyMessage={profitsQuery.isError ? "Couldn't load profit analytics." : 'No profit recorded for this range.'}
      >
        <AreaChart data={profitItems} xKey="bucket" series={[{ key: 'netProfit', label: 'Net profit', colorIndex: 0 }]} valueFormatter={formatCoins} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Snipe outcomes"
          description="Attempts vs. successes per day."
          isLoading={activityQuery.isLoading}
          isEmpty={!activityQuery.isLoading && !activityQuery.isError && activityItems.length === 0}
          emptyMessage={activityQuery.isError ? "Couldn't load activity analytics." : 'No snipe activity for this range.'}
        >
          <BarChart
            data={activityItems}
            xKey="bucket"
            series={[
              { key: 'snipeAttempts', label: 'Attempts', colorIndex: 1 },
              { key: 'snipeSuccesses', label: 'Successes', colorIndex: 0 },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Coins traded"
          description="Total coins moved per day (buy + sell)."
          isLoading={profitsQuery.isLoading}
          isEmpty={!profitsQuery.isLoading && !profitsQuery.isError && profitItems.length === 0}
        >
          <BarChart data={profitItems} xKey="bucket" series={[{ key: 'coinsTraded', label: 'Coins traded', colorIndex: 2 }]} valueFormatter={formatCoins} />
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
          <Card>
            <CardHeader>
              <CardTitle>Filter performance</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState
                title="Not queryable from the dashboard yet"
                description="Saved-filter realised-return history (filter_stats) is currently write-only from the extension's POST /filters/stats sync — there is no GET endpoint to read it back. Flagged as a follow-up in docs/07-dashboard.md."
                action={
                  <Button variant="outline" size="sm" onClick={() => void profitsQuery.refetch()}>
                    Refresh
                  </Button>
                }
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default AnalyticsPage;
