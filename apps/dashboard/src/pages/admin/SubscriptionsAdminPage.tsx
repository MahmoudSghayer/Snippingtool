import {
  AreaChart,
  Badge,
  ChartCard,
  ChartLegend,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  DonutChart,
  Drawer,
  FormField,
  Input,
  KpiGrid,
  PageHeader,
  Select,
  seriesColor,
  seriesLegendItems,
  StatTile,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { SUBSCRIPTION_STATUSES } from '@sl/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';


import { api } from '@/api/client.js';
import { SubscriptionActions } from '@/components/SubscriptionActions.js';

import type { AdminSubscriptionListItem } from '@sl/shared';

const ANY = 'any';

const columns: ColumnDef<AdminSubscriptionListItem, unknown>[] = [
  { accessorKey: 'userEmail', header: 'User' },
  { accessorKey: 'plan', header: 'Plan', cell: (c) => (c.getValue() as AdminSubscriptionListItem['plan']).name },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => {
      const v = c.getValue() as string;
      return <Badge tone={v === 'active' || v === 'trialing' || v === 'lifetime' ? 'positive' : v === 'canceled' || v === 'expired' ? 'negative' : 'warning'}>{v}</Badge>;
    },
  },
  { accessorKey: 'currentPeriodEnd', header: 'Period ends', cell: (c) => (c.getValue() ? new Date(c.getValue() as string).toLocaleDateString() : '—') },
];

/** `/admin/subscriptions` — plan-mix analytics (existing) plus (docs/07-dashboard.md
 * §11 gap #2) the real `GET /admin/subscriptions` list: filterable by
 * status/plan/userId/search, with a row drawer that resolves the
 * subscription id (`SubscriptionActions`) so extend/suspend/cancel/
 * device-limit are reachable directly from here, not only from a specific
 * user's `/admin/users` detail drawer. */
export function SubscriptionsAdminPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));
  const [status, setStatus] = useState(ANY);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<AdminSubscriptionListItem | null>(null);

  const metricsQuery = useQuery({
    queryKey: ['admin', 'analytics', 'subscriptions', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/subscriptions', { params: { query: range } });
      if (error) throw error;
      return data;
    },
  });

  const listQuery = useQuery({
    queryKey: ['admin', 'subscriptions', 'list', status, search, cursor],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/subscriptions', {
        params: { query: { status: status === ANY ? undefined : (status as never), search: search || undefined, cursor, limit: 50 } },
      });
      if (error) throw error;
      return data;
    },
  });

  const items = metricsQuery.data?.items ?? [];
  const planMix = Object.entries(metricsQuery.data?.planMix ?? {}).map(([key, value], i) => ({ key, label: key, value, colorIndex: i }));
  const newVsCanceledSeries = [
    { key: 'newSubscriptions', label: 'New', colorIndex: 0 },
    { key: 'canceledSubscriptions', label: 'Canceled', colorIndex: 2 },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Subscriptions" description="Plan mix, subscription lifecycle metrics, and every account's subscription." actions={<DateRangePicker value={range} onChange={setRange} />} />

      <KpiGrid>
        <StatTile label="Past due" value={metricsQuery.data?.pastDueCount ?? '—'} invertDeltaTone />
        <StatTile label="New subscriptions" value={items.reduce((sum, i) => sum + i.newSubscriptions, 0)} />
        <StatTile label="Cancellations" value={items.reduce((sum, i) => sum + i.canceledSubscriptions, 0)} invertDeltaTone />
        <StatTile label="Coupon redemptions" value={items.reduce((sum, i) => sum + i.couponRedemptions, 0)} />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="New vs. canceled"
          className="lg:col-span-2"
          legend={<ChartLegend items={seriesLegendItems(newVsCanceledSeries)} />}
          isLoading={metricsQuery.isLoading}
          isEmpty={!metricsQuery.isLoading && !metricsQuery.isError && items.length === 0}
          emptyMessage={metricsQuery.isError ? "Couldn't load subscription analytics." : 'No activity in this range.'}
        >
          <AreaChart data={items} xKey="bucket" series={newVsCanceledSeries} />
        </ChartCard>
        <ChartCard
          title="Plan mix"
          legend={<ChartLegend items={planMix.map((d) => ({ key: d.key, label: d.label, color: seriesColor(d.colorIndex) }))} />}
          isLoading={metricsQuery.isLoading}
          isEmpty={!metricsQuery.isLoading && planMix.length === 0}
        >
          <DonutChart data={planMix} />
        </ChartCard>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 className="text-sm font-semibold text-ink">All subscriptions</h2>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Search" htmlFor="sub-search" className="w-64">
            <Input id="sub-search" placeholder="Owner email contains…" value={search} onChange={(e) => { setSearch(e.target.value); setCursor(undefined); setCursorStack([]); }} />
          </FormField>
          <FormField label="Status" htmlFor="sub-status" className="w-44">
            <Select
              value={status}
              onValueChange={(v) => { setStatus(v); setCursor(undefined); setCursorStack([]); }}
              options={[{ value: ANY, label: 'Any status' }, ...SUBSCRIPTION_STATUSES.map((s) => ({ value: s, label: s }))]}
            />
          </FormField>
        </div>

        <DataTable
          columns={columns}
          data={listQuery.data?.items ?? []}
          isLoading={listQuery.isLoading}
          isError={listQuery.isError}
          onRetry={() => void listQuery.refetch()}
          emptyTitle="No subscriptions match these filters"
          getRowId={(row) => row.id}
          onRowClick={setSelected}
          hasNextPage={!!listQuery.data?.nextCursor}
          hasPreviousPage={cursorStack.length > 0}
          onNextPage={() => {
            if (!listQuery.data?.nextCursor) return;
            setCursorStack((s) => [...s, cursor ?? '']);
            setCursor(listQuery.data.nextCursor);
          }}
          onPreviousPage={() => {
            setCursorStack((s) => {
              const next = [...s];
              const prev = next.pop();
              setCursor(prev || undefined);
              return next;
            });
          }}
        />
      </div>

      {selected && (
        <Drawer open onOpenChange={(open) => !open && setSelected(null)} title={selected.userEmail} description={`Subscription ${selected.id}`}>
          <SubscriptionActions userId={selected.userId} />
        </Drawer>
      )}
    </div>
  );
}

export default SubscriptionsAdminPage;
