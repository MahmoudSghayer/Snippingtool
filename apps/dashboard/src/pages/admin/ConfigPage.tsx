import { Badge, Button, DataTable, FormField, Input, Modal, PageHeader, Textarea, type ColumnDef } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';

import type { SystemConfigDto } from '@sl/shared';


/** `/admin/config` — system config key/value pairs, masked secrets. `GET
 * /admin/config` already masks `isSecret` values server-side
 * ("[hidden]") for a caller without `config.write`, per docs/03-api.md — the
 * dashboard doesn't add a second layer of masking on top, it just renders
 * exactly what the API returns. */
export function ConfigPage() {
  const queryClient = useQueryClient();
  const [editTarget, setEditTarget] = useState<SystemConfigDto | null>(null);
  const [valueDraft, setValueDraft] = useState('');
  const [isSecretDraft, setIsSecretDraft] = useState(false);

  const configQuery = useQuery({
    queryKey: ['admin', 'config'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/config');
      if (error) throw error;
      return data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ key, value, isSecret }: { key: string; value: unknown; isSecret: boolean }) => {
      const { error } = await api.PUT('/api/v1/admin/config/{key}', { params: { path: { key } }, body: { value, isSecret } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Config updated');
      setEditTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'config'] });
    },
    onError: (error) => toast.error("Couldn't update config", { description: apiErrorMessage(error) }),
  });

  function openEdit(row: SystemConfigDto) {
    setEditTarget(row);
    setValueDraft(row.value === '[hidden]' ? '' : JSON.stringify(row.value, null, 2));
    setIsSecretDraft(row.isSecret);
  }

  function submitEdit() {
    if (!editTarget) return;
    let parsed: unknown = valueDraft;
    try {
      parsed = JSON.parse(valueDraft);
    } catch {
      // Not valid JSON — send as a raw string, which is a legitimate config value shape too.
    }
    updateMutation.mutate({ key: editTarget.key, value: parsed, isSecret: isSecretDraft });
  }

  const columns: ColumnDef<SystemConfigDto, unknown>[] = [
    { accessorKey: 'key', header: 'Key', cell: (c) => <span className="font-mono">{c.getValue() as string}</span> },
    {
      accessorKey: 'value',
      header: 'Value',
      cell: (c) => (
        <span className="font-mono text-xs text-ink-2">
          {c.row.original.isSecret ? <Badge tone="warning">Secret</Badge> : JSON.stringify(c.getValue())}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="System config" description="Runtime configuration keys, with secrets masked unless you hold config.write." />

      <DataTable
        columns={columns}
        data={configQuery.data ?? []}
        isLoading={configQuery.isLoading}
        isError={configQuery.isError}
        onRetry={() => void configQuery.refetch()}
        emptyTitle="No config keys yet"
        getRowId={(row) => row.key}
        rowActions={(row) => (
          <Button size="sm" variant="outline" onClick={() => openEdit(row)}>
            Edit
          </Button>
        )}
      />

      <Modal
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        title={editTarget ? `Edit ${editTarget.key}` : ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button loading={updateMutation.isPending} onClick={submitEdit}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Value (JSON or plain text)" htmlFor="config-value">
            <Textarea id="config-value" rows={6} value={valueDraft} onChange={(e) => setValueDraft(e.target.value)} className="font-mono text-xs" />
          </FormField>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Input type="checkbox" checked={isSecretDraft} onChange={(e) => setIsSecretDraft(e.target.checked)} className="h-4 w-4" />
            Mark as secret
          </label>
        </div>
      </Modal>
    </div>
  );
}

export default ConfigPage;
