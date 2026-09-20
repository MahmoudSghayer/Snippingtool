import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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
import type { ActivityAnalyticsPoint, ActivityAnalyticsResponse, ProfitAnalyticsResponse } from '@sl/shared';

import { analyticsGet } from '@/api/analyticsClient.js';

const activityColumns: ColumnDef<ActivityAnalyticsPoint, unknown>[] = [
  { accessorKey: 'bucket', header: 'Date' },
  { accessorKey: 'logins', header: 'Logins' },
  { accessorKey: 'searches', header: 'Searches' },
  { accessorKey: 'filterChanges', header: 'Filter changes' },
  { accessorKey: 'snipeAttempts', header: 'Snipe attempts' },
  { accessorKey: 'snipeSuccesses', header: 'Snipe successes' },
  { accessorKey: 'errors', header: 'Errors' },
];

/** Consumes `@sl/shared`'s analytics DTOs against `/analytics/me/*` — see
 * src/api/analyticsClient.ts's header comment for why this goes through a
 * plain fetch instead of the generated openapi-fetch client: those routes
 * hadn't landed in apps/api/openapi/openapi.json as of this pass. Every
 * panel below degrades to an explicit empty state instead of erroring when
 * the service 404s. */
export function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));

  const profitsQuery = useQuery({
    queryKey: ['analytics', 'me', 'profits', range],
    queryFn: () => analyticsGet<ProfitAnalyticsResponse>('/analytics/me/profits', { ...range, granularity: 'day' }),
  });

  const activityQuery = useQuery({
    queryKey: ['analytics', 'me', 'activity', range],
    queryFn: () => analyticsGet<ActivityAnalyticsResponse>('/analytics/me/activity', { ...range, granularity: 'day' }),
  });

  const profitItems = profitsQuery.data?.data?.items ?? [];
  const activityItems = activityQuery.data?.data?.items ?? [];

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
        isEmpty={!profitsQuery.isLoading && profitItems.length === 0}
        emptyMessage={
          profitsQuery.data?.error ? "Profit analytics aren't available yet — check back soon." : 'No profit recorded for this range.'
        }
      >
        <AreaChart data={profitItems} xKey="bucket" series={[{ key: 'netProfit', label: 'Net profit', colorIndex: 0 }]} valueFormatter={formatCoins} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Snipe outcomes"
          description="Attempts vs. successes per day."
          isLoading={activityQuery.isLoading}
          isEmpty={!activityQuery.isLoading && activityItems.length === 0}
          emptyMessage={activityQuery.data?.error ? "Activity analytics aren't available yet — check back soon." : 'No snipe activity for this range.'}
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
          isEmpty={!profitsQuery.isLoading && profitItems.length === 0}
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
                isError={!!activityQuery.data?.error}
                errorMessage="Activity analytics aren't available yet."
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
