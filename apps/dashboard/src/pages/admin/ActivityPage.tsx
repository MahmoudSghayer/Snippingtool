import {
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartCard,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  EmptyState,
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

/** `apps/api`'s `admin-activity` module declares no Zod response schema for
 * `logins`/`searches`/`snipes`/`errors`/`ips` (docs/03-api.md calls them
 * "raw rows from user_activity/search_activity/sniping_activity" but the
 * OpenAPI document's `200.content` is empty for all five — confirmed against
 * the generated `schema.d.ts`, which types their `data` as `never`). This
 * generic row shape and cast is the dashboard's best-effort reading of what
 * `docs/02-database.md`'s underlying tables actually contain; flagged as a
 * follow-up in docs/07-dashboard.md ("Known API gaps") rather than guessed
 * away by adding a stricter interface for a contract that doesn't exist yet. */
interface RawActivityRow {
  id?: string;
  occurredAt?: string;
  type?: string;
  deviceId?: string | null;
  ip?: string | null;
  resultsCount?: number;
  outcome?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

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

function useRawActivity(path: '/api/v1/admin/activity/logins' | '/api/v1/admin/activity/searches' | '/api/v1/admin/activity/snipes' | '/api/v1/admin/activity/errors', range: DateRange) {
  return useQuery({
    queryKey: ['admin', 'activity', path, range],
    queryFn: async () => {
      const { data, error } = await api.GET(path, { params: { query: { ...toRangeQuery(range), limit: 100 } } });
      if (error) throw error;
      const body = data as unknown;
      const rows = Array.isArray(body) ? body : ((body as { items?: RawActivityRow[] } | undefined)?.items ?? []);
      return rows as RawActivityRow[];
    },
  });
}

const rawColumns: ColumnDef<RawActivityRow, unknown>[] = [
  { accessorKey: 'occurredAt', header: 'Time', cell: (c) => (c.getValue() ? new Date(c.getValue() as string).toLocaleString() : '—') },
  { accessorKey: 'deviceId', header: 'Device', cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string | null) ?? '—'}</span> },
  { accessorKey: 'ip', header: 'IP', cell: (c) => (c.getValue() as string | null) ?? '—' },
  {
    id: 'details',
    header: 'Details',
    cell: ({ row }) => {
      const { id: _id, occurredAt: _o, deviceId: _d, ip: _i, ...rest } = row.original;
      return <span className="font-mono text-xs text-ink-2">{JSON.stringify(rest)}</span>;
    },
  },
];

function RawActivityTab({ path, range }: { path: '/api/v1/admin/activity/logins' | '/api/v1/admin/activity/searches' | '/api/v1/admin/activity/snipes' | '/api/v1/admin/activity/errors'; range: DateRange }) {
  const query = useRawActivity(path, range);
  return (
    <DataTable
      columns={rawColumns}
      data={query.data ?? []}
      isLoading={query.isLoading}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      emptyTitle="No events in this range"
      getRowId={(row, i) => row.id ?? String(i)}
    />
  );
}

/** `/admin/activity` — logins, searches, filter changes, snipes, errors,
 * devices, IPs. Each tab is its own date-ranged, filtered DataTable. */
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
      const body = data as unknown;
      return (Array.isArray(body) ? body : ((body as { items?: RawActivityRow[] } | undefined)?.items ?? [])) as RawActivityRow[];
    },
  });

  const osData = Object.entries(devicesQuery.data?.byOs ?? {}).map(([key, value], i) => ({ bucket: key, count: value, colorIndex: i }));
  const versionData = Object.entries(devicesQuery.data?.byVersion ?? {}).map(([key, value], i) => ({ bucket: key, count: value, colorIndex: i }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity" description="Logins, searches, snipes, errors and network activity." actions={<DateRangePicker value={range} onChange={setRange} />} />

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
          <Card>
            <CardContent className="pt-5">
              <RawActivityTab path="/api/v1/admin/activity/logins" range={range} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="searches">
          <Card>
            <CardContent className="pt-5">
              <RawActivityTab path="/api/v1/admin/activity/searches" range={range} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="filters">
          <Card>
            <CardHeader>
              <CardTitle>Filter changes</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState
                title="No dedicated endpoint yet"
                description="user_activity rows of type filter_change aren't exposed by a dedicated /admin/activity route — only logins, searches, snipes and errors are. Flagged as a follow-up in docs/07-dashboard.md."
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="snipes">
          <Card>
            <CardContent className="pt-5">
              <RawActivityTab path="/api/v1/admin/activity/snipes" range={range} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="errors">
          <Card>
            <CardContent className="pt-5">
              <RawActivityTab path="/api/v1/admin/activity/errors" range={range} />
            </CardContent>
          </Card>
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
                columns={rawColumns}
                data={ipsQuery.data ?? []}
                isLoading={ipsQuery.isLoading}
                isError={ipsQuery.isError}
                onRetry={() => void ipsQuery.refetch()}
                emptyTitle="No IP activity recorded"
                getRowId={(row, i) => row.id ?? String(i)}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ActivityPage;
