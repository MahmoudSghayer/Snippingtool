import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Gauge, Laptop, ShieldCheck, TrendingUp } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  formatCoins,
  formatDateTime,
  formatPercent,
  KpiGrid,
  PageHeader,
  StatTile,
  type ColumnDef,
} from '@sl/ui';
import type { MeOverviewResponse } from '@sl/shared';
import type { Trade } from '@sl/shared';

import { api } from '@/api/client.js';
import { analyticsGet } from '@/api/analyticsClient.js';

const tradeColumns: ColumnDef<Trade, unknown>[] = [
  { accessorKey: 'resourceId', header: 'Player', cell: (c) => <span className="font-mono">{c.getValue() as number}</span> },
  { accessorKey: 'status', header: 'Status', cell: (c) => <Badge tone={c.getValue() === 'sold' ? 'positive' : 'neutral'}>{c.getValue() as string}</Badge> },
  { accessorKey: 'buyPrice', header: 'Buy', cell: (c) => <span className="font-mono tabular-nums">{formatCoins(c.getValue() as number)}</span> },
  {
    accessorKey: 'sellPrice',
    header: 'Sell',
    cell: (c) => <span className="font-mono tabular-nums">{c.getValue() ? formatCoins(c.getValue() as number) : '—'}</span>,
  },
  {
    accessorKey: 'netProfit',
    header: 'Net profit',
    cell: (c) => {
      const value = c.getValue() as number | null;
      if (value === null) return <span className="text-ink-2">—</span>;
      return <span className={`font-mono tabular-nums ${value >= 0 ? 'text-live' : 'text-risk'}`}>{formatCoins(value)}</span>;
    },
  },
  { accessorKey: 'boughtAt', header: 'Bought', cell: (c) => formatDateTime(c.getValue() as string) },
];

export function DashboardPage() {
  const overviewQuery = useQuery({
    queryKey: ['analytics', 'me', 'overview'],
    queryFn: () => analyticsGet<MeOverviewResponse>('/analytics/me/overview'),
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/devices');
      if (error) throw error;
      return data;
    },
  });

  const licenseQuery = useQuery({
    queryKey: ['license', 'me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/licenses/me');
      if (error) throw error;
      return data;
    },
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await api.GET('/settings');
      if (error) throw error;
      return data;
    },
  });

  const tradesQuery = useQuery({
    queryKey: ['trades', 'recent'],
    queryFn: async () => {
      const { data, error } = await api.GET('/trades', { params: { query: { limit: 8 } } });
      if (error) throw error;
      return data;
    },
  });

  const overview = overviewQuery.data?.data;
  const activeDevices = devicesQuery.data?.filter((d) => d.status === 'active').length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Your profit, snipes and account at a glance." />

      <KpiGrid>
        <StatTile
          label="Net profit (7d)"
          value={overview ? formatCoins(overview.last7d.netProfit) : overviewQuery.isLoading ? '…' : '—'}
          icon={<TrendingUp className="size-4" />}
        />
        <StatTile
          label="Net profit (30d)"
          value={overview ? formatCoins(overview.last30d.netProfit) : overviewQuery.isLoading ? '…' : '—'}
        />
        <StatTile
          label="Snipe success rate"
          value={overview ? formatPercent(overview.snipeSuccessRateLifetime) : overviewQuery.isLoading ? '…' : '—'}
          icon={<Gauge className="size-4" />}
        />
        <StatTile label="Active devices" value={activeDevices} icon={<Laptop className="size-4" />} />
      </KpiGrid>

      {!overviewQuery.isLoading && !overview && (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              title="Live profit analytics aren't available yet"
              description="This account's overview will appear here once the analytics service is deployed. Recent trades and license status below are already live."
            />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent trades</CardTitle>
            <Link to="/analytics" className="text-xs text-gold hover:underline">
              View analytics
            </Link>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={tradeColumns}
              data={tradesQuery.data?.items ?? []}
              isLoading={tradesQuery.isLoading}
              isError={tradesQuery.isError}
              onRetry={() => void tradesQuery.refetch()}
              emptyTitle="No trades reported yet"
              emptyDescription="Trades your extension reports will show up here."
              getRowId={(row) => row.id}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>License</CardTitle>
              <ShieldCheck className="size-4 text-ink-2" />
            </CardHeader>
            <CardContent>
              {licenseQuery.data ? (
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-ink-2">Key</span>
                    <span className="font-mono">{licenseQuery.data.keyPrefix}…</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Status</span>
                    <Badge tone={licenseQuery.data.status === 'active' ? 'positive' : 'negative'}>{licenseQuery.data.status}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Devices</span>
                    <span>
                      {activeDevices} / {licenseQuery.data.maxDevices}
                    </span>
                  </div>
                  <Link to="/subscriptions">
                    <Button variant="outline" size="sm" className="mt-2 w-full">
                      Manage license
                    </Button>
                  </Link>
                </div>
              ) : (
                <EmptyState title="No license yet" description="Start a subscription to get a license key." />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Risk posture</CardTitle>
            </CardHeader>
            <CardContent>
              {settingsQuery.data ? (
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-ink-2">Actions / hour</span>
                    <span className="font-mono tabular-nums">{settingsQuery.data.governor.actionsPerHour}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Session length</span>
                    <span className="font-mono tabular-nums">{settingsQuery.data.governor.sessionLengthMinutes}m</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Buy:search ratio</span>
                    <span className="font-mono tabular-nums">{settingsQuery.data.governor.buyToSearchRatio.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Coin flow / hour</span>
                    <span className="font-mono tabular-nums">{formatCoins(settingsQuery.data.governor.maxCoinFlowPerHour)}</span>
                  </div>
                  <Link to="/settings">
                    <Button variant="outline" size="sm" className="mt-2 w-full">
                      Adjust budgets
                    </Button>
                  </Link>
                </div>
              ) : (
                <EmptyState title="No budget configured yet" />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
