import { zodResolver } from '@hookform/resolvers/zod';
import { createCouponRequestSchema, PLAN_CODES } from '@sl/shared';
import { Badge, Button, Checkbox, DataTable, FormField, Input, Modal, PageHeader, Select, type ColumnDef } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';


import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

import type { z } from 'zod';

type CouponRow = NonNullable<Awaited<ReturnType<typeof fetchCoupons>>>['items'][number];

async function fetchCoupons() {
  const { data, error } = await api.GET('/api/v1/admin/coupons');
  if (error) throw error;
  return data;
}

type CreateForm = z.infer<typeof createCouponRequestSchema>;

export function CouponsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<CouponRow | null>(null);

  const couponsQuery = useQuery({ queryKey: ['admin', 'coupons'], queryFn: fetchCoupons });

  const createForm = useForm<CreateForm>({
    resolver: zodResolver(createCouponRequestSchema),
    defaultValues: { code: '', type: 'percent', value: 10, planCodes: [...PLAN_CODES], maxRedemptions: null, expiresAt: null, reason: '' },
  });

  const createMutation = useMutation({
    mutationFn: async (values: CreateForm) => {
      const { error } = await api.POST('/api/v1/admin/coupons', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Coupon created');
      setCreateOpen(false);
      createForm.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'coupons'] });
    },
    onError: (error) => toast.error("Couldn't create coupon", { description: apiErrorMessage(error) }),
  });

  const disableMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await api.PATCH('/api/v1/admin/coupons/{id}', { params: { path: { id } }, body: { isActive: false, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Coupon disabled');
      setDisableTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'coupons'] });
    },
    onError: (error) => toast.error("Couldn't disable coupon", { description: apiErrorMessage(error) }),
  });

  const columns: ColumnDef<CouponRow, unknown>[] = [
    { accessorKey: 'code', header: 'Code', cell: (c) => <span className="font-mono">{c.getValue() as string}</span> },
    { accessorKey: 'type', header: 'Type' },
    { accessorKey: 'value', header: 'Value' },
    { accessorKey: 'redeemedCount', header: 'Redeemed' },
    { accessorKey: 'maxRedemptions', header: 'Max', cell: (c) => (c.getValue() as number | null) ?? '∞' },
    { accessorKey: 'isActive', header: 'Status', cell: (c) => <Badge tone={c.getValue() ? 'positive' : 'neutral'}>{c.getValue() ? 'Active' : 'Disabled'}</Badge> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Coupons" description="Percent, fixed, free-days and lifetime coupons." actions={<Button onClick={() => setCreateOpen(true)}>New coupon</Button>} />

      <DataTable
        columns={columns}
        data={couponsQuery.data?.items ?? []}
        isLoading={couponsQuery.isLoading}
        isError={couponsQuery.isError}
        onRetry={() => void couponsQuery.refetch()}
        emptyTitle="No coupons yet"
        getRowId={(row) => row.id}
        rowActions={(row) =>
          row.isActive && (
            <Button size="sm" variant="outline" onClick={() => setDisableTarget(row)}>
              Disable
            </Button>
          )
        }
      />

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create coupon"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button loading={createMutation.isPending} onClick={createForm.handleSubmit((v) => createMutation.mutate(v))}>
              Create
            </Button>
          </>
        }
      >
        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Code" htmlFor="code" error={createForm.formState.errors.code?.message}>
            <Input id="code" {...createForm.register('code', { setValueAs: (v) => String(v).toUpperCase() })} />
          </FormField>
          <FormField label="Type" htmlFor="type">
            <Select
              value={createForm.watch('type')}
              onValueChange={(v) => createForm.setValue('type', v as CreateForm['type'])}
              options={[
                { value: 'percent', label: 'Percent off' },
                { value: 'fixed', label: 'Fixed amount' },
                { value: 'free_days', label: 'Free days' },
                { value: 'lifetime', label: 'Lifetime' },
              ]}
            />
          </FormField>
          <FormField label="Value" htmlFor="value" error={createForm.formState.errors.value?.message}>
            <Input id="value" type="number" step="0.01" {...createForm.register('value', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Max redemptions" htmlFor="maxRedemptions" hint="Empty = unlimited">
            <Input
              id="maxRedemptions"
              type="number"
              {...createForm.register('maxRedemptions', { setValueAs: (v) => (v === '' ? null : Number(v)) })}
            />
          </FormField>
          <FormField label="Eligible plans" htmlFor="planCodes" className="sm:col-span-2" error={createForm.formState.errors.planCodes?.message}>
            <div className="flex flex-wrap gap-3">
              {PLAN_CODES.map((code) => (
                <label key={code} className="flex items-center gap-1.5 text-sm text-ink">
                  <Checkbox
                    checked={createForm.watch('planCodes').includes(code)}
                    onCheckedChange={(checked) => {
                      const current = createForm.getValues('planCodes');
                      createForm.setValue('planCodes', checked ? [...current, code] : current.filter((c) => c !== code));
                    }}
                  />
                  {code}
                </label>
              ))}
            </div>
          </FormField>
          <FormField label="Reason" htmlFor="reason" className="sm:col-span-2" error={createForm.formState.errors.reason?.message}>
            <Input id="reason" {...createForm.register('reason')} />
          </FormField>
        </form>
      </Modal>

      <ReasonDialog
        open={!!disableTarget}
        onOpenChange={(open) => !open && setDisableTarget(null)}
        title={`Disable ${disableTarget?.code ?? ''}`}
        destructive
        confirmLabel="Disable"
        loading={disableMutation.isPending}
        onConfirm={(reason) => disableTarget && disableMutation.mutate({ id: disableTarget.id, reason })}
      />
    </div>
  );
}

export default CouponsPage;
