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
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Gauge, Laptop, ShieldCheck, TrendingUp } from 'lucide-react';

import { api } from '@/api/client.js';
import { ExtensionDownloadCard } from '@/components/ExtensionDownload.js';

import type { Trade } from '@sl/shared';

const tradeColumns: ColumnDef<Trade, unknown>[] = [
  {
    accessorKey: 'resourceId',
    header: 'Player',
    cell: (c) => <span className="font-mono">{c.getValue() as number}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => (
      <Badge tone={c.getValue() === 'sold' ? 'positive' : 'neutral'}>
        {c.getValue() as string}
      </Badge>
    ),
  },
  {
    accessorKey: 'buyPrice',
    header: 'Buy',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatCoins(c.getValue() as number)}</span>
    ),
  },
  {
    accessorKey: 'sellPrice',
    header: 'Sell',
    cell: (c) => (
      <span className="font-mono tabular-nums">
        {c.getValue() ? formatCoins(c.getValue() as number) : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'netProfit',
    header: 'Net profit',
    cell: (c) => {
      const value = c.getValue() as number | null;
      if (value === null) return <span className="text-ink-2">—</span>;
      return (
        <span className={`font-mono tabular-nums ${value >= 0 ? 'text-live' : 'text-risk'}`}>
          {formatCoins(value)}
        </span>
      );
    },
  },
  {
    accessorKey: 'boughtAt',
    header: 'Bought',
    cell: (c) => formatDateTime(c.getValue() as string),
  },
];

export function DashboardPage() {
  const overviewQuery = useQuery({
    queryKey: ['analytics', 'me', 'overview'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/analytics/me/overview');
      if (error) throw error;
      return data;
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/devices');
      if (error) throw error;
      return data;
    },
  });

  const licenseQuery = useQuery({
    queryKey: ['license', 'me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/licenses/me');
      if (error) throw error;
      return data;
    },
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings');
      if (error) throw error;
      return data;
    },
  });

  const tradesQuery = useQuery({
    queryKey: ['trades', 'recent'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/trades', { params: { query: { limit: 8 } } });
      if (error) throw error;
      return data;
    },
  });

  // docs/07-dashboard.md §11 gap #6: last-24h governor event history
  // (`GET /risk-events`), rendered alongside the configured budget below.
  const riskEventsQuery = useQuery({
    queryKey: ['risk-events', 'last24h'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/risk-events', {
        params: {
          query: { from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), limit: 200 },
        },
      });
      if (error) throw error;
      return data.items;
    },
  });

  const overview = overviewQuery.data;
  const activeDevices = devicesQuery.data?.filter((d) => d.status === 'active').length ?? 0;
  const riskEvents = riskEventsQuery.data ?? [];
  const riskCountsByKind = riskEvents.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  const recentHardStops = riskEvents
    .filter((e) => e.kind === 'hard_stop' || e.kind === 'kill_switch')
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Your profit, snipes and account at a glance." />

      <ExtensionDownloadCard variant="compact" hideWhenNotEntitled />

      <KpiGrid>
        <StatTile
          label="Net profit (7d)"
          value={
            overview ? formatCoins(overview.last7d.netProfit) : overviewQuery.isLoading ? '…' : '—'
          }
          icon={<TrendingUp className="size-4" />}
        />
        <StatTile
          label="Net profit (30d)"
          value={
            overview ? formatCoins(overview.last30d.netProfit) : overviewQuery.isLoading ? '…' : '—'
          }
        />
        <StatTile
          label="Snipe success rate"
          value={
            overview
              ? formatPercent(overview.snipeSuccessRateLifetime)
              : overviewQuery.isLoading
                ? '…'
                : '—'
          }
          icon={<Gauge className="size-4" />}
        />
        <StatTile
          label="Active devices"
          value={activeDevices}
          icon={<Laptop className="size-4" />}
        />
      </KpiGrid>

      {overviewQuery.isError && (
        <Card>
          <CardContent className="pt-5">
            <EmptyState
              icon={<AlertTriangle className="size-6" />}
              title="Couldn't load your profit overview"
              description="Recent trades and license status below are unaffected."
              action={
                <Button size="sm" variant="outline" onClick={() => void overviewQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent trades</CardTitle>
            <Link
              to="/trades"
              className="text-xs text-gold underline underline-offset-2 hover:text-gold/80"
            >
              All trades
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
                    <Badge tone={licenseQuery.data.status === 'active' ? 'positive' : 'negative'}>
                      {licenseQuery.data.status}
                    </Badge>
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
                <EmptyState
                  title="No license yet"
                  description="Start a subscription to get a license key."
                />
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
                    <span className="font-mono tabular-nums">
                      {settingsQuery.data.governor.actionsPerHour}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Session length</span>
                    <span className="font-mono tabular-nums">
                      {settingsQuery.data.governor.sessionLengthMinutes}m
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Buy:search ratio</span>
                    <span className="font-mono tabular-nums">
                      {settingsQuery.data.governor.buyToSearchRatio.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-2">Coin flow / hour</span>
                    <span className="font-mono tabular-nums">
                      {formatCoins(settingsQuery.data.governor.maxCoinFlowPerHour)}
                    </span>
                  </div>

                  <div className="mt-2 border-t border-line pt-2">
                    <p className="mb-1.5 text-xs text-ink-2">Last 24h</p>
                    {riskEventsQuery.isLoading ? (
                      <p className="text-xs text-ink-2">Loading…</p>
                    ) : riskEvents.length === 0 ? (
                      <p className="text-xs text-ink-2">No governor events in the last 24h.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(riskCountsByKind).map(([kind, count]) => (
                          <Badge
                            key={kind}
                            tone={
                              kind === 'hard_stop' || kind === 'kill_switch'
                                ? 'negative'
                                : 'neutral'
                            }
                          >
                            {kind.replace(/_/g, ' ')}: {count}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {recentHardStops.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {recentHardStops.map((e) => (
                          <li key={e.id} className="flex justify-between text-xs text-ink-2">
                            <span className="text-risk">{e.kind.replace(/_/g, ' ')}</span>
                            <span>{formatDateTime(e.occurredAt)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
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
