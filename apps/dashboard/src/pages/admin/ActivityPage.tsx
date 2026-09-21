import {
  Badge,
  BarChart,
  Card,
  CardContent,
  ChartCard,
  DataTable,
  DateRangePicker,
  defaultDateRange,
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
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';


import { api } from '@/api/client.js';

import type {
  AdminErrorActivityRow,
  AdminFilterChangeActivityRow,
  AdminIpActivityRow,
  AdminLoginActivityRow,
  AdminSearchActivityRow,
  AdminSnipeActivityRow,
} from '@sl/shared';

// `apps/api`'s `admin-activity` routes validate `from`/`to` as full
// `z.string().datetime()` values (see docs/03-api.md), but `DateRangePicker`
// (`@sl/ui`) works in bare `YYYY-MM-DD` dates for its own display/CSV-naming
// purposes (`AuditPage`'s date-range calls do the same conversion for the
// same reason) — expand to inclusive UTC day bounds before it ever reaches
// `fetch`, otherwise every request 400s (caught by the visual-smoke e2e's
// zero-console-errors assertion).
function toRangeQuery(range: DateRange): { from: string; to: string } {
  return { from: `${range.from}T00:00:00.000Z`, to: `${range.to}T23:59:59.999Z` };
}

const deviceCell = (c: { getValue: () => unknown }) => <span className="font-mono text-xs">{(c.getValue() as string | null) ?? '—'}</span>;
const timeCell = (c: { getValue: () => unknown }) => (c.getValue() ? new Date(c.getValue() as string).toLocaleString() : '—');

const loginColumns: ColumnDef<AdminLoginActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: timeCell },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { accessorKey: 'deviceId', header: 'Device', cell: deviceCell },
  { accessorKey: 'ip', header: 'IP', cell: (c) => (c.getValue() as string | null) ?? '—' },
  { id: 'mfa', header: 'MFA', cell: ({ row }) => (row.original.metadata.mfaUsed ? <Badge tone="positive">Used</Badge> : '—') },
];

const errorColumns: ColumnDef<AdminErrorActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: timeCell },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { accessorKey: 'deviceId', header: 'Device', cell: deviceCell },
  { id: 'code', header: 'Code', cell: ({ row }) => <span className="font-mono text-xs">{String(row.original.metadata.code ?? '—')}</span> },
  { id: 'context', header: 'Context', cell: ({ row }) => String(row.original.metadata.context ?? '—') },
  { id: 'message', header: 'Message', cell: ({ row }) => <span className="text-xs text-ink-2">{String(row.original.metadata.message ?? '—')}</span> },
];

const searchColumns: ColumnDef<AdminSearchActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: timeCell },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { accessorKey: 'resourceId', header: 'Resource', cell: (c) => (c.getValue() as string | null) ?? '—' },
  { accessorKey: 'resultsCount', header: 'Results' },
  { accessorKey: 'floorPrice', header: 'Floor price', cell: (c) => (c.getValue() != null ? (c.getValue() as number).toLocaleString() : '—') },
];

const snipeOutcomeTone: Record<string, 'positive' | 'negative' | 'warning' | 'neutral'> = {
  success: 'positive',
  failed: 'negative',
  error: 'negative',
  blocked: 'warning',
  too_slow: 'warning',
  attempted: 'neutral',
};

const snipeColumns: ColumnDef<AdminSnipeActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: timeCell },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { accessorKey: 'resourceId', header: 'Resource' },
  { accessorKey: 'targetPrice', header: 'Target price', cell: (c) => (c.getValue() as number).toLocaleString() },
  { accessorKey: 'outcome', header: 'Outcome', cell: (c) => <Badge tone={snipeOutcomeTone[c.getValue() as string] ?? 'neutral'}>{c.getValue() as string}</Badge> },
  { accessorKey: 'latencyMs', header: 'Latency (ms)', cell: (c) => (c.getValue() != null ? c.getValue() : '—') },
];

const filterChangeColumns: ColumnDef<AdminFilterChangeActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: timeCell },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { id: 'action', header: 'Action', cell: ({ row }) => <Badge tone="neutral">{row.original.metadata.action}</Badge> },
  { id: 'filterId', header: 'Filter', cell: ({ row }) => <span className="font-mono text-xs">{row.original.metadata.filterId ?? '—'}</span> },
];

const ipColumns: ColumnDef<AdminIpActivityRow, unknown>[] = [
  { accessorKey: 'ip', header: 'IP' },
  { accessorKey: 'userId', header: 'User', cell: deviceCell },
  { accessorKey: 'country', header: 'Country', cell: (c) => (c.getValue() as string | null) ?? '—' },
  { accessorKey: 'requestCount', header: 'Requests' },
  { accessorKey: 'lastSeen', header: 'Last seen', cell: timeCell },
  { accessorKey: 'flagged', header: 'Flagged', cell: (c) => (c.getValue() ? <Badge tone="negative">Flagged</Badge> : '—') },
];

function useActivity<
  Path extends
    | '/api/v1/admin/activity/logins'
    | '/api/v1/admin/activity/searches'
    | '/api/v1/admin/activity/snipes'
    | '/api/v1/admin/activity/errors'
    | '/api/v1/admin/activity/filter-changes',
  Row,
>(path: Path, range: DateRange) {
  return useQuery({
    queryKey: ['admin', 'activity', path, range],
    queryFn: async () => {
      // `path` is generic over a union of route keys here, which defeats
      // openapi-fetch's per-path `init` overload resolution (each path's
      // querystring shape is actually identical — `rangeQuery` — but TS
      // can't see that through the union) — narrowed back with an explicit
      // cast rather than losing the shared-hook structure across five
      // otherwise-identical tabs.
      const { data, error } = await (api.GET as (p: string, init: unknown) => ReturnType<typeof api.GET>)(path, {
        params: { query: { ...toRangeQuery(range), limit: 100 } },
      });
      if (error) throw error;
      return (data as unknown as { items: Row[] }).items;
    },
  });
}

function ActivityTab<Row extends { id: string }>({
  path,
  range,
  columns,
  emptyTitle,
}: {
  path:
    | '/api/v1/admin/activity/logins'
    | '/api/v1/admin/activity/searches'
    | '/api/v1/admin/activity/snipes'
    | '/api/v1/admin/activity/errors'
    | '/api/v1/admin/activity/filter-changes';
  range: DateRange;
  columns: ColumnDef<Row, unknown>[];
  emptyTitle: string;
}) {
  const query = useActivity<typeof path, Row>(path, range);
  return (
    <Card>
      <CardContent className="pt-5">
        <DataTable
          columns={columns}
          data={query.data ?? []}
          isLoading={query.isLoading}
          isError={query.isError}
          onRetry={() => void query.refetch()}
          emptyTitle={emptyTitle}
          getRowId={(row) => row.id}
        />
      </CardContent>
    </Card>
  );
}

/** `/admin/activity` — logins, searches, filter changes, snipes, errors,
 * devices, IPs. Each tab is its own date-ranged, typed DataTable, backed by
 * the response schemas in `@sl/shared`'s `schemas/activity.ts`
 * (docs/07-dashboard.md §11 gap #4). */
export function ActivityPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('7d'));

  const devicesQuery = useQuery({
    queryKey: ['admin', 'activity', 'devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/activity/devices');
      if (error) throw error;
      return data;
    },
  });

  const ipsQuery = useQuery({
    queryKey: ['admin', 'activity', 'ips'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/activity/ips', { params: { query: { limit: 100 } } });
      if (error) throw error;
      return data;
    },
  });

  const osData = Object.entries(devicesQuery.data?.byOs ?? {}).map(([key, value], i) => ({ bucket: key, count: value, colorIndex: i }));
  const versionData = Object.entries(devicesQuery.data?.byVersion ?? {}).map(([key, value], i) => ({ bucket: key, count: value, colorIndex: i }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity" description="Logins, searches, filter changes, snipes, errors and network activity." actions={<DateRangePicker value={range} onChange={setRange} />} />

      <Tabs defaultValue="logins">
        <TabsList>
          <TabsTrigger value="logins">Logins</TabsTrigger>
          <TabsTrigger value="searches">Searches</TabsTrigger>
          <TabsTrigger value="filters">Filter changes</TabsTrigger>
          <TabsTrigger value="snipes">Snipes</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
          <TabsTrigger value="ips">IPs</TabsTrigger>
        </TabsList>

        <TabsContent value="logins">
          <ActivityTab path="/api/v1/admin/activity/logins" range={range} columns={loginColumns} emptyTitle="No logins in this range" />
        </TabsContent>
        <TabsContent value="searches">
          <ActivityTab path="/api/v1/admin/activity/searches" range={range} columns={searchColumns} emptyTitle="No searches in this range" />
        </TabsContent>
        <TabsContent value="filters">
          <ActivityTab path="/api/v1/admin/activity/filter-changes" range={range} columns={filterChangeColumns} emptyTitle="No filter changes in this range" />
        </TabsContent>
        <TabsContent value="snipes">
          <ActivityTab path="/api/v1/admin/activity/snipes" range={range} columns={snipeColumns} emptyTitle="No snipe attempts in this range" />
        </TabsContent>
        <TabsContent value="errors">
          <ActivityTab path="/api/v1/admin/activity/errors" range={range} columns={errorColumns} emptyTitle="No errors in this range" />
        </TabsContent>
        <TabsContent value="devices">
          <div className="flex flex-col gap-4">
            <KpiGrid>
              <StatTile label="Active devices" value={devicesQuery.data?.total ?? '—'} />
            </KpiGrid>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ChartCard title="By OS" isLoading={devicesQuery.isLoading} isEmpty={!devicesQuery.isLoading && osData.length === 0}>
                <BarChart data={osData} xKey="bucket" series={[{ key: 'count', label: 'Devices', colorIndex: 0 }]} />
              </ChartCard>
              <ChartCard title="By extension version" isLoading={devicesQuery.isLoading} isEmpty={!devicesQuery.isLoading && versionData.length === 0}>
                <BarChart data={versionData} xKey="bucket" series={[{ key: 'count', label: 'Devices', colorIndex: 1 }]} />
              </ChartCard>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="ips">
          <Card>
            <CardContent className="pt-5">
              <DataTable
                columns={ipColumns}
                data={ipsQuery.data ?? []}
                isLoading={ipsQuery.isLoading}
                isError={ipsQuery.isError}
                onRetry={() => void ipsQuery.refetch()}
                emptyTitle="No IP activity recorded"
                getRowId={(row) => row.ip}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ActivityPage;
