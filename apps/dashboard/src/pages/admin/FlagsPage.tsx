import { FLAG_KINDS, FLAG_SEVERITIES, FLAG_STATUSES } from '@sl/shared';
import { Badge, Button, DataTable, formatDateTime, PageHeader, Select, type BadgeTone, type ColumnDef } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';


import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

import type { FlagStatus } from '@sl/shared';

type FlagRow = NonNullable<Awaited<ReturnType<typeof fetchFlags>>>['items'][number];

async function fetchFlags(filters: { status?: string; kind?: string; severity?: string }) {
  const { data, error } = await api.GET('/api/v1/admin/flags', {
    params: { query: { status: filters.status as never, kind: filters.kind as never, severity: filters.severity as never } },
  });
  if (error) throw error;
  return data;
}

const severityTone: Record<string, BadgeTone> = { low: 'neutral', medium: 'warning', high: 'negative', critical: 'negative' };

const ANY = 'any';

export function FlagsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('open');
  const [kind, setKind] = useState<string>(ANY);
  const [severity, setSeverity] = useState<string>(ANY);
  const [reviewTarget, setReviewTarget] = useState<{ row: FlagRow; action: 'reviewed' | 'dismissed' } | null>(null);

  const flagsQuery = useQuery({
    queryKey: ['admin', 'flags', status, kind, severity],
    queryFn: () =>
      fetchFlags({
        status: status === ANY ? undefined : status,
        kind: kind === ANY ? undefined : kind,
        severity: severity === ANY ? undefined : severity,
      }),
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; status: 'reviewed' | 'dismissed'; reason: string }) => {
      const { error } = await api.POST('/api/v1/admin/flags/{id}/review', { params: { path: { id } }, body: { status, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Flag updated');
      setReviewTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'flags'] });
    },
    onError: (error) => toast.error("Couldn't update flag", { description: apiErrorMessage(error) }),
  });

  const columns: ColumnDef<FlagRow, unknown>[] = [
    { accessorKey: 'createdAt', header: 'When', cell: (c) => formatDateTime(c.getValue() as string) },
    { accessorKey: 'userId', header: 'User', cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span> },
    { accessorKey: 'kind', header: 'Kind' },
    { accessorKey: 'severity', header: 'Severity', cell: (c) => <Badge tone={severityTone[c.getValue() as string]}>{c.getValue() as string}</Badge> },
    { accessorKey: 'status', header: 'Status', cell: (c) => <Badge tone={c.getValue() === 'open' ? 'warning' : c.getValue() === 'reviewed' ? 'positive' : 'neutral'}>{c.getValue() as string}</Badge> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Flags" description="Abuse and fraud signals from trial protection and abuse.scan." />

      <div className="flex flex-wrap gap-3">
        <Select value={status} onValueChange={setStatus} options={[{ value: ANY, label: 'Any status' }, ...FLAG_STATUSES.map((s) => ({ value: s, label: s }))]} className="w-44" />
        <Select value={kind} onValueChange={setKind} options={[{ value: ANY, label: 'Any kind' }, ...FLAG_KINDS.map((k) => ({ value: k, label: k }))]} className="w-52" />
        <Select value={severity} onValueChange={setSeverity} options={[{ value: ANY, label: 'Any severity' }, ...FLAG_SEVERITIES.map((s) => ({ value: s, label: s }))]} className="w-44" />
      </div>

      <DataTable
        columns={columns}
        data={flagsQuery.data?.items ?? []}
        isLoading={flagsQuery.isLoading}
        isError={flagsQuery.isError}
        onRetry={() => void flagsQuery.refetch()}
        emptyTitle="No flags match these filters"
        getRowId={(row) => row.id}
        rowActions={(row) =>
          row.status === 'open' && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setReviewTarget({ row, action: 'reviewed' })}>
                Mark reviewed
              </Button>
              <Button size="sm" variant="outline" onClick={() => setReviewTarget({ row, action: 'dismissed' })}>
                Dismiss
              </Button>
            </div>
          )
        }
      />

      <ReasonDialog
        open={!!reviewTarget}
        onOpenChange={(open) => !open && setReviewTarget(null)}
        title={reviewTarget?.action === 'dismissed' ? 'Dismiss flag' : 'Mark flag reviewed'}
        confirmLabel={reviewTarget?.action === 'dismissed' ? 'Dismiss' : 'Mark reviewed'}
        loading={reviewMutation.isPending}
        onConfirm={(reason) => reviewTarget && reviewMutation.mutate({ id: reviewTarget.row.id, status: reviewTarget.action as FlagStatus & ('reviewed' | 'dismissed'), reason })}
      />
    </div>
  );
}

export default FlagsPage;
