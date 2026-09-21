import { zodResolver } from '@hookform/resolvers/zod';
import { planCreateRequestSchema } from '@sl/shared';
import {
  Badge,
  Button,
  DataTable,
  formatCurrencyFromCents,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  Switch,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

import type { z } from 'zod';

type PlanRow = NonNullable<Awaited<ReturnType<typeof fetchPlans>>>['items'][number];
type CreateForm = z.infer<typeof planCreateRequestSchema>;

async function fetchPlans() {
  const { data, error } = await api.GET('/api/v1/admin/plans');
  if (error) throw error;
  return data;
}

export function PlansPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<PlanRow | null>(null);

  const plansQuery = useQuery({ queryKey: ['admin', 'plans'], queryFn: fetchPlans });

  const createForm = useForm<CreateForm>({
    resolver: zodResolver(planCreateRequestSchema),
    defaultValues: {
      code: '',
      name: '',
      priceCents: 0,
      currency: 'usd',
      interval: 'month',
      isLifetime: false,
      deviceLimit: 1,
      features: [],
      sortOrder: 0,
      reason: '',
    },
  });

  const createMutation = useMutation({
    mutationFn: async (values: CreateForm) => {
      const { error } = await api.POST('/api/v1/admin/plans', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Plan created');
      setCreateOpen(false);
      createForm.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
    },
    onError: (error) =>
      toast.error("Couldn't create plan", { description: apiErrorMessage(error) }),
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await api.POST('/api/v1/admin/plans/{id}/archive', {
        params: { path: { id } },
        body: { reason },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Plan archived');
      setArchiveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
    },
    onError: (error) =>
      toast.error("Couldn't archive plan", { description: apiErrorMessage(error) }),
  });

  const columns: ColumnDef<PlanRow, unknown>[] = [
    {
      accessorKey: 'code',
      header: 'Code',
      cell: (c) => <span className="font-mono">{c.getValue() as string}</span>,
    },
    { accessorKey: 'name', header: 'Name' },
    {
      accessorKey: 'priceCents',
      header: 'Price',
      cell: (c) => formatCurrencyFromCents(c.getValue() as number),
    },
    { accessorKey: 'interval', header: 'Interval' },
    { accessorKey: 'deviceLimit', header: 'Devices' },
    {
      accessorKey: 'isLifetime',
      header: 'Lifetime',
      cell: (c) => (c.getValue() ? <Badge tone="accent">Lifetime</Badge> : '—'),
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      cell: (c) => (
        <Badge tone={c.getValue() ? 'positive' : 'neutral'}>
          {c.getValue() ? 'Active' : 'Archived'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plans"
        description="Every plan, including lifetime and archived ones."
        actions={<Button onClick={() => setCreateOpen(true)}>New plan</Button>}
      />

      <DataTable
        columns={columns}
        data={plansQuery.data?.items ?? []}
        isLoading={plansQuery.isLoading}
        isError={plansQuery.isError}
        onRetry={() => void plansQuery.refetch()}
        emptyTitle="No plans yet"
        getRowId={(row) => row.id}
        rowActions={(row) =>
          row.isActive && (
            <Button size="sm" variant="outline" onClick={() => setArchiveTarget(row)}>
              Archive
            </Button>
          )
        }
      />

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create plan"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={createMutation.isPending}
              onClick={createForm.handleSubmit((v) => createMutation.mutate(v))}
            >
              Create
            </Button>
          </>
        }
      >
        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Code"
            htmlFor="code"
            hint="lowercase-with-dashes"
            error={createForm.formState.errors.code?.message}
          >
            <Input id="code" {...createForm.register('code')} />
          </FormField>
          <FormField label="Name" htmlFor="name" error={createForm.formState.errors.name?.message}>
            <Input id="name" {...createForm.register('name')} />
          </FormField>
          <FormField
            label="Price (cents)"
            htmlFor="priceCents"
            error={createForm.formState.errors.priceCents?.message}
          >
            <Input
              id="priceCents"
              type="number"
              {...createForm.register('priceCents', { valueAsNumber: true })}
            />
          </FormField>
          <FormField label="Interval" htmlFor="interval">
            <Select
              value={createForm.watch('interval')}
              onValueChange={(v) => createForm.setValue('interval', v as CreateForm['interval'])}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
                { value: 'year', label: 'Year' },
                { value: 'one_time', label: 'One-time' },
              ]}
            />
          </FormField>
          <FormField
            label="Device limit"
            htmlFor="deviceLimit"
            error={createForm.formState.errors.deviceLimit?.message}
          >
            <Input
              id="deviceLimit"
              type="number"
              min={1}
              max={10}
              {...createForm.register('deviceLimit', { valueAsNumber: true })}
            />
          </FormField>
          <FormField label="Features (comma-separated)" htmlFor="features">
            <Input
              id="features"
              onChange={(e) =>
                createForm.setValue(
                  'features',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </FormField>
          <FormField label="Lifetime plan" htmlFor="isLifetime">
            <Switch
              checked={createForm.watch('isLifetime')}
              onCheckedChange={(v) => createForm.setValue('isLifetime', v)}
            />
          </FormField>
          <FormField
            label="Reason"
            htmlFor="reason"
            className="sm:col-span-2"
            error={createForm.formState.errors.reason?.message}
          >
            <Input id="reason" {...createForm.register('reason')} />
          </FormField>
        </form>
      </Modal>

      <ReasonDialog
        open={!!archiveTarget}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title={`Archive ${archiveTarget?.name ?? ''}`}
        destructive
        confirmLabel="Archive"
        loading={archiveMutation.isPending}
        onConfirm={(reason) =>
          archiveTarget && archiveMutation.mutate({ id: archiveTarget.id, reason })
        }
      />
    </div>
  );
}

export default PlansPage;
