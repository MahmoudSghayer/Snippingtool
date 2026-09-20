import {
  ChartCard,
  DateRangePicker,
  defaultDateRange,
  DonutChart,
  formatCurrencyFromCents,
  formatPercent,
  KpiGrid,
  LineChart,
  PageHeader,
  StatTile,
  type DateRange,
} from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, DollarSign, TrendingUp, Users } from 'lucide-react';
import { useState } from 'react';


import { api } from '@/api/client.js';
import { useAdminLiveStore } from '@/stores/adminLive.js';

/** `/admin` — KPI overview. Live online/active-snipe/error counters come
 * from the WS `admin.overview.tick` push (src/hooks/useWsGateway.ts ->
 * useAdminLiveStore); revenue/retention/conversion/churn come from `GET
 * /admin/analytics/overview`. */
export function OverviewPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));

  const overviewQuery = useQuery({
    queryKey: ['admin', 'analytics', 'overview', range],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/overview', { params: { query: range } });
      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });

  const tick = useAdminLiveStore((s) => s.lastTick);
  const overview = overviewQuery.data;

  const retentionData = (overview?.retention ?? []).map((r) => ({
    bucket: r.cohortWeek,
    d7: Math.round(r.retentionD7 * 1000) / 10,
    d30: Math.round(r.retentionD30 * 1000) / 10,
  }));

  const versionData = Object.entries(overview?.versionDistribution ?? {}).map(([key, value], i) => ({
    key,
    label: key,
    value,
    colorIndex: i,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="Platform health and growth at a glance." actions={<DateRangePicker value={range} onChange={setRange} />} />

      <KpiGrid>
        <StatTile label="Online users" value={tick?.onlineUsers ?? overview?.onlineUsers ?? '—'} icon={<Users className="size-4" />} />
        <StatTile label="Total users" value={overview ? overview.totalUsers.toLocaleString() : '—'} icon={<Users className="size-4" />} />
        <StatTile label="MRR" value={overview ? formatCurrencyFromCents(overview.mrrCents) : '—'} icon={<DollarSign className="size-4" />} />
        <StatTile label="ARR" value={overview ? formatCurrencyFromCents(overview.arrCents) : '—'} icon={<TrendingUp className="size-4" />} />
      </KpiGrid>

      <KpiGrid>
        <StatTile label="Conversion" value={overview ? formatPercent(overview.conversion.rate) : '—'} />
        <StatTile label="Churn" value={overview ? formatPercent(overview.churn.rate) : '—'} invertDeltaTone />
        <StatTile label="Active snipes (1m)" value={tick?.activeSnipesLastMinute ?? '—'} icon={<Activity className="size-4" />} />
        <StatTile label="Errors (1m)" value={tick?.errorsLastMinute ?? '—'} icon={<AlertTriangle className="size-4" />} invertDeltaTone />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="Retention"
          description="7-day and 30-day cohort retention."
          className="lg:col-span-2"
          isLoading={overviewQuery.isLoading}
          isEmpty={!overviewQuery.isLoading && !overviewQuery.isError && retentionData.length === 0}
          emptyMessage={overviewQuery.isError ? "Couldn't load overview analytics." : 'No cohort data yet.'}
        >
          <LineChart data={retentionData} xKey="bucket" series={[{ key: 'd7', label: 'D7 retention %', colorIndex: 0 }, { key: 'd30', label: 'D30 retention %', colorIndex: 1 }]} />
        </ChartCard>

        <ChartCard
          title="Extension versions"
          description="Active-device version distribution."
          isLoading={overviewQuery.isLoading}
          isEmpty={!overviewQuery.isLoading && !overviewQuery.isError && versionData.length === 0}
        >
          <DonutChart data={versionData} centerValue={overview ? String(overview.extensionInstalls.total) : undefined} centerLabel="installs" />
        </ChartCard>
      </div>

      {overviewQuery.isError && (
        <p className="text-xs text-ink-2">
          Revenue/retention analytics couldn&apos;t be loaded for this range. Live online-user and activity counters above
          still work via WebSocket regardless.
        </p>
      )}
    </div>
  );
}

export default OverviewPage;
