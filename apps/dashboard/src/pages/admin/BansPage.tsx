import { zodResolver } from '@hookform/resolvers/zod';
import { BAN_TYPES } from '@sl/shared';
import { Badge, Button, DataTable, formatDate, FormField, Input, PageHeader, Select, type ColumnDef } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';


import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

type BanRow = NonNullable<Awaited<ReturnType<typeof fetchBans>>>['items'][number];

async function fetchBans() {
  const { data, error } = await api.GET('/api/v1/admin/bans', { params: { query: {} } });
  if (error) throw error;
  return data;
}

const createBanFormSchema = z.object({
  type: z.enum(BAN_TYPES),
  userId: z.string().uuid('Enter a valid user ID').optional().or(z.literal('')),
  value: z.string().max(320).optional(),
});
type CreateBanForm = z.infer<typeof createBanFormSchema>;

export function BansPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [liftTarget, setLiftTarget] = useState<BanRow | null>(null);

  const bansQuery = useQuery({ queryKey: ['admin', 'bans'], queryFn: fetchBans });

  const createForm = useForm<CreateBanForm>({ resolver: zodResolver(createBanFormSchema), defaultValues: { type: 'account', userId: '', value: '' } });

  const createMutation = useMutation({
    mutationFn: async (reason: string) => {
      const values = createForm.getValues();
      const { error } = await api.POST('/api/v1/admin/bans', {
        body: {
          type: values.type,
          userId: values.userId || undefined,
          value: values.type === 'account' ? undefined : values.value,
          reason,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Ban created');
      setCreateOpen(false);
      createForm.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] });
    },
    onError: (error) => toast.error("Couldn't create ban", { description: apiErrorMessage(error) }),
  });

  const liftMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await api.POST('/api/v1/admin/bans/{id}/lift', { params: { path: { id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Ban lifted');
      setLiftTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] });
    },
    onError: (error) => toast.error("Couldn't lift ban", { description: apiErrorMessage(error) }),
  });

  const columns: ColumnDef<BanRow, unknown>[] = [
    { accessorKey: 'type', header: 'Type' },
    { accessorKey: 'value', header: 'Value', cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string) || '—'}</span> },
    { accessorKey: 'reason', header: 'Reason' },
    { accessorKey: 'expiresAt', header: 'Expires', cell: (c) => (c.getValue() ? formatDate(c.getValue() as string) : 'Never') },
    { accessorKey: 'liftedAt', header: 'Status', cell: (c) => <Badge tone={c.getValue() ? 'neutral' : 'negative'}>{c.getValue() ? 'Lifted' : 'Active'}</Badge> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Bans" description="Account, IP, device and hardware bans." actions={<Button onClick={() => setCreateOpen(true)}>New ban</Button>} />

      <DataTable
        columns={columns}
        data={bansQuery.data?.items ?? []}
        isLoading={bansQuery.isLoading}
        isError={bansQuery.isError}
        onRetry={() => void bansQuery.refetch()}
        emptyTitle="No bans yet"
        getRowId={(row) => row.id}
        rowActions={(row) =>
          !row.liftedAt && (
            <Button size="sm" variant="outline" onClick={() => setLiftTarget(row)}>
              Lift
            </Button>
          )
        }
      />

      <ReasonDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) createForm.reset();
        }}
        title="Create ban"
        confirmLabel="Create ban"
        destructive
        loading={createMutation.isPending}
        onConfirm={(reason) => createMutation.mutate(reason)}
        extraFields={
          <>
            <FormField label="Type" htmlFor="ban-type">
              <Select
                value={createForm.watch('type')}
                onValueChange={(v) => createForm.setValue('type', v as CreateBanForm['type'])}
                options={BAN_TYPES.map((t) => ({ value: t, label: t }))}
              />
            </FormField>
            <FormField label="User ID" htmlFor="ban-userId" hint="Required for account bans">
              <Input id="ban-userId" {...createForm.register('userId')} />
            </FormField>
            {createForm.watch('type') !== 'account' && (
              <FormField label="Value" htmlFor="ban-value" hint="IP address, device fingerprint or HWID">
                <Input id="ban-value" {...createForm.register('value')} />
              </FormField>
            )}
          </>
        }
      />

      <ReasonDialog
        open={!!liftTarget}
        onOpenChange={(open) => !open && setLiftTarget(null)}
        title="Lift ban"
        confirmLabel="Lift ban"
        loading={liftMutation.isPending}
        onConfirm={(reason) => liftTarget && liftMutation.mutate({ id: liftTarget.id, reason })}
      />
    </div>
  );
}

export default BansPage;
