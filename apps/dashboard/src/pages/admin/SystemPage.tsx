import { Badge, BarChart, Button, Card, CardContent, CardHeader, CardTitle, ChartCard, KpiGrid, PageHeader, StatTile } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { Database, RefreshCw, Server, Wifi } from 'lucide-react';


import { api } from '@/api/client.js';

/** `/admin/system` — API/DB/queue/WS/extension health, version distribution,
 * error rate, manual refresh. `GET /admin/system/health` composes all of it
 * in one call. */
export function SystemPage() {
  const healthQuery = useQuery({
    queryKey: ['admin', 'system', 'health'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/system/health');
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
  });

  const health = healthQuery.data;
  const queueRows = Object.entries(health?.queues ?? {});
  const versionData = Object.entries(health?.extensionVersions ?? {}).map(([key, value], i) => ({ bucket: key, count: value, colorIndex: i }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System"
        description="Live health of the API, database, queues, WebSocket gateway and extension fleet."
        actions={
          <Button variant="outline" size="sm" leftIcon={<RefreshCw className="size-4" />} loading={healthQuery.isFetching} onClick={() => void healthQuery.refetch()}>
            Refresh
          </Button>
        }
      />

      <KpiGrid>
        <StatTile label="API uptime" value={health ? formatUptime(health.uptimeSeconds) : '—'} icon={<Server className="size-4" />} />
        <StatTile
          label="Database"
          value={health ? <Badge tone={health.db.connected ? 'positive' : 'negative'}>{health.db.connected ? 'Connected' : 'Down'}</Badge> : '—'}
          icon={<Database className="size-4" />}
        />
        <StatTile label="WS online users" value={health?.wsOnlineUsers ?? '—'} icon={<Wifi className="size-4" />} />
        <StatTile label="Error rate (5m)" value={health ? `${(health.errorRateLast5Min * 100).toFixed(2)}%` : '—'} invertDeltaTone />
      </KpiGrid>

      <Card>
        <CardHeader>
          <CardTitle>Redis</CardTitle>
        </CardHeader>
        <CardContent>
          {health?.redis ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
              <div className="flex justify-between sm:block">
                <span className="text-ink-2">Connected clients</span>
                <span className="ml-2 font-mono sm:ml-0 sm:block">{health.redis.connectedClients ?? '—'}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-ink-2">Used memory</span>
                <span className="ml-2 font-mono sm:ml-0 sm:block">{health.redis.usedMemory ?? '—'}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-ink-2">Uptime</span>
                <span className="ml-2 font-mono sm:ml-0 sm:block">{health.redis.uptimeInSeconds ?? '—'}s</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-2">No Redis stats available.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Queues</CardTitle>
        </CardHeader>
        <CardContent>
          {queueRows.length === 0 ? (
            <p className="text-sm text-ink-2">No queue data available.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-ink-2">
                  <th className="py-2">Queue</th>
                  <th className="py-2">Waiting</th>
                  <th className="py-2">Active</th>
                  <th className="py-2">Completed</th>
                  <th className="py-2">Failed</th>
                  <th className="py-2">Delayed</th>
                </tr>
              </thead>
              <tbody>
                {queueRows.map(([name, q]) => (
                  <tr key={name} className="border-b border-line last:border-0">
                    <td className="py-2 font-mono">{name}</td>
                    <td className="py-2 tabular-nums">{q.waiting}</td>
                    <td className="py-2 tabular-nums">{q.active}</td>
                    <td className="py-2 tabular-nums">{q.completed}</td>
                    <td className="py-2 tabular-nums text-risk">{q.failed}</td>
                    <td className="py-2 tabular-nums">{q.delayed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ChartCard title="Extension version distribution" isLoading={healthQuery.isLoading} isEmpty={!healthQuery.isLoading && versionData.length === 0}>
        <BarChart data={versionData} xKey="bucket" series={[{ key: 'count', label: 'Active devices', colorIndex: 0 }]} />
      </ChartCard>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default SystemPage;
