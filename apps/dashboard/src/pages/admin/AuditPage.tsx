import {
  Button,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  DiffViewer,
  Drawer,
  FormField,
  formatDateTime,
  Input,
  PageHeader,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';


import { api, apiErrorMessage } from '@/api/client.js';
import { downloadServerCsv } from '@/lib/csv.js';

import type { AuditLogEntry } from '@sl/shared';

/** `/admin/audit` — filterable audit log with a before/after diff viewer.
 * "Export CSV" streams the full filtered range server-side (`GET
 * /admin/audit/export.csv`, same status/entity/date filters as the list
 * above) rather than only exporting what's currently loaded on screen. */
export function AuditPage() {
  const [range, setRange] = useState<DateRange>(defaultDateRange('30d'));
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const filterQuery = {
    from: `${range.from}T00:00:00.000Z`,
    to: `${range.to}T23:59:59.999Z`,
    ...(entityType ? { entityType } : {}),
    ...(entityId ? { entityId } : {}),
  };

  const auditQuery = useQuery({
    queryKey: ['admin', 'audit', range, entityType, entityId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/audit', {
        params: { query: { ...filterQuery, limit: 200 } },
      });
      if (error) throw error;
      return data as AuditLogEntry[];
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const qs = new URLSearchParams(filterQuery as Record<string, string>).toString();
      await downloadServerCsv(`audit-${range.from}-${range.to}.csv`, `/api/v1/admin/audit/export.csv?${qs}`);
    },
    onError: (error) => toast.error("Couldn't export audit log", { description: apiErrorMessage(error) }),
  });

  const columns: ColumnDef<AuditLogEntry, unknown>[] = [
    { accessorKey: 'occurredAt', header: 'When', cell: (c) => formatDateTime(c.getValue() as string) },
    { accessorKey: 'actorType', header: 'Actor' },
    { accessorKey: 'action', header: 'Action' },
    { accessorKey: 'entityType', header: 'Entity' },
    { accessorKey: 'entityId', header: 'Entity ID', cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string | null) ?? '—'}</span> },
  ];

  const rows = auditQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every admin and system action, with before/after diffs."
        actions={
          <div className="flex items-center gap-2">
            <DateRangePicker value={range} onChange={setRange} />
            <Button variant="outline" size="sm" loading={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              Export CSV
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Entity type" htmlFor="entityType" className="w-48">
          <Input id="entityType" placeholder="user, subscription…" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
        </FormField>
        <FormField label="Entity ID" htmlFor="entityId" className="w-64">
          <Input id="entityId" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        </FormField>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        isLoading={auditQuery.isLoading}
        isError={auditQuery.isError}
        onRetry={() => void auditQuery.refetch()}
        emptyTitle="No audit entries for this range"
        getRowId={(row) => row.id}
        onRowClick={setSelected}
      />

      <Drawer open={!!selected} onOpenChange={(open) => !open && setSelected(null)} title={selected?.action ?? ''} description={selected ? formatDateTime(selected.occurredAt) : ''}>
        {selected && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-ink-2">Actor</p>
                <p>
                  {selected.actorType} {selected.actorId && <span className="font-mono text-xs">{selected.actorId}</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-2">Entity</p>
                <p>
                  {selected.entityType} <span className="font-mono text-xs">{selected.entityId}</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-2">Request ID</p>
                <p className="font-mono text-xs">{selected.requestId ?? '—'}</p>
              </div>
            </div>
            <DiffViewer before={selected.before} after={selected.after} />
          </div>
        )}
      </Drawer>
    </div>
  );
}

export default AuditPage;
