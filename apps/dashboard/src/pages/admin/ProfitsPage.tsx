import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartCard,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  formatCoins,
  KpiGrid,
  PageHeader,
  StatTile,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { AreaChart } from '@sl/ui/charts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client.js';
import { downloadCsv } from '@/lib/csv.js';

import type { ProfitLeaderboardEntry } from '@sl/shared';

const leaderboardColumns: ColumnDef<ProfitLeaderboardEntry, unknown>[] = [
  { accessorKey: 'rank', header: '#' },
  { accessorKey: 'email', header: 'User' },
  {
    accessorKey: 'netProfit',
    header: 'Net profit',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatCoins(c.getValue() as number)}</span>
    ),
  },
  {
    accessorKey: 'coinsTraded',
    header: 'Coins traded',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatCoins(c.getValue() as number)}</span>
    ),
  },
  { accessorKey: 'snipes', header: 'Snipes' },
  { accessorKey: 'successes', header: 'Successes' },
];

/** `/admin/profits` — date range, per-user leaderboards, daily chart, coins
 * traded, average profit, CSV export. */
export function ProfitsPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));

  const profitsQuery = useQuery({
    queryKey: ['admin', 'analytics', 'profits', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/profits', {
        params: { query: range },
      });
      if (error) throw error;
      return data;
    },
  });

  const topQuery = useQuery({
    queryKey: ['admin', 'analytics', 'leaderboard', range, 'top'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/profits/leaderboard', {
        params: { query: { ...range, order: 'top', limit: 20 } },
      });
      if (error) throw error;
      return data;
    },
  });

  const leastQuery = useQuery({
    queryKey: ['admin', 'analytics', 'leaderboard', range, 'least'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/profits/leaderboard', {
        params: { query: { ...range, order: 'least', limit: 20 } },
      });
      if (error) throw error;
      return data;
    },
  });

  const items = profitsQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Profits"
        description="Coin profit across the platform."
        actions={
          <div className="flex items-center gap-2">
            <DateRangePicker value={range} onChange={setRange} />
            <Button
              variant="outline"
              size="sm"
              disabled={items.length === 0}
              onClick={() => downloadCsv(`profits-${range.from}-${range.to}.csv`, items)}
            >
              Export CSV
            </Button>
          </div>
        }
      />

      <KpiGrid>
        <StatTile
          label="Total net profit"
          value={profitsQuery.data ? formatCoins(profitsQuery.data.lifetime.netProfit) : '—'}
        />
        <StatTile
          label="Coins traded"
          value={profitsQuery.data ? formatCoins(profitsQuery.data.lifetime.coinsTraded) : '—'}
        />
        <StatTile
          label="Avg profit / active trader"
          value={
            profitsQuery.data
              ? formatCoins(Math.round(profitsQuery.data.lifetime.avgProfitPerActiveTrader))
              : '—'
          }
        />
        <StatTile label="Days in range" value={items.length} />
      </KpiGrid>

      <ChartCard
        title="Net profit over time"
        isLoading={profitsQuery.isLoading}
        isEmpty={!profitsQuery.isLoading && !profitsQuery.isError && items.length === 0}
        emptyMessage={
          profitsQuery.isError
            ? "Couldn't load profit analytics."
            : 'No profit recorded for this range.'
        }
      >
        <AreaChart
          data={items}
          xKey="bucket"
          series={[{ key: 'netProfit', label: 'Net profit', colorIndex: 0 }]}
          valueFormatter={formatCoins}
        />
      </ChartCard>

      <Card>
        <CardHeader>
          <CardTitle>Leaderboards</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="top">
            <TabsList>
              <TabsTrigger value="top">Top earners</TabsTrigger>
              <TabsTrigger value="least">Least active</TabsTrigger>
            </TabsList>
            <TabsContent value="top">
              <DataTable
                columns={leaderboardColumns}
                data={topQuery.data?.items ?? []}
                isLoading={topQuery.isLoading}
                isError={topQuery.isError}
                onRetry={() => void topQuery.refetch()}
                emptyTitle="No trades in this range"
                getRowId={(row) => row.userId}
              />
            </TabsContent>
            <TabsContent value="least">
              <DataTable
                columns={leaderboardColumns}
                data={leastQuery.data?.items ?? []}
                isLoading={leastQuery.isLoading}
                isError={leastQuery.isError}
                onRetry={() => void leastQuery.refetch()}
                emptyTitle="No trades in this range"
                getRowId={(row) => row.userId}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

export default ProfitsPage;
