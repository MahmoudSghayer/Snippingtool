import { AreaChart, ChartCard, DateRangePicker, defaultDateRange, DonutChart, EmptyState, KpiGrid, PageHeader, StatTile, type DateRange } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';


import { api } from '@/api/client.js';

/** `/admin/subscriptions` — plan mix and subscription metrics from `GET
 * /admin/analytics/subscriptions`. There is no `GET /admin/subscriptions`
 * list endpoint in the current API (only per-user/per-subscription action
 * routes: activate, extend, suspend, unsuspend, cancel, grant-lifetime) —
 * those are surfaced from a specific user's detail drawer on `/admin/users`
 * instead, which is where an admin actually has a `userId`/subscription
 * `id` in hand. See docs/07-dashboard.md "Known API gaps". */
export function SubscriptionsAdminPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));

  const metricsQuery = useQuery({
    queryKey: ['admin', 'analytics', 'subscriptions', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/subscriptions', { params: { query: range } });
      if (error) throw error;
      return data;
    },
  });

  const items = metricsQuery.data?.items ?? [];
  const planMix = Object.entries(metricsQuery.data?.planMix ?? {}).map(([key, value], i) => ({ key, label: key, value, colorIndex: i }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Subscriptions" description="Plan mix and subscription lifecycle metrics." actions={<DateRangePicker value={range} onChange={setRange} />} />

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
          isLoading={metricsQuery.isLoading}
          isEmpty={!metricsQuery.isLoading && !metricsQuery.isError && items.length === 0}
          emptyMessage={metricsQuery.isError ? "Couldn't load subscription analytics." : 'No activity in this range.'}
        >
          <AreaChart
            data={items}
            xKey="bucket"
            series={[
              { key: 'newSubscriptions', label: 'New', colorIndex: 0 },
              { key: 'canceledSubscriptions', label: 'Canceled', colorIndex: 4 },
            ]}
          />
        </ChartCard>
        <ChartCard title="Plan mix" isLoading={metricsQuery.isLoading} isEmpty={!metricsQuery.isLoading && planMix.length === 0}>
          <DonutChart data={planMix} />
        </ChartCard>
      </div>

      <EmptyState
        title="Per-subscription actions live on the user's detail page"
        description="Activate, extend, suspend, cancel and grant-lifetime all act on one user's subscription — open that user from /admin/users to manage it."
      />
    </div>
  );
}

export default SubscriptionsAdminPage;
