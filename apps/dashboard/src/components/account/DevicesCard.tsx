// "Devices" on /account: every device signed in to this account, with a
// revoke button for all but the current one.
import { Badge, Button, Card, CardContent, DataTable, formatDate, type ColumnDef } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop } from 'lucide-react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';

import type { DeviceDto } from '@sl/shared';

const deviceColumns: ColumnDef<DeviceDto, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Device',
    cell: (c) => (
      <div className="flex items-center gap-2">
        <Laptop className="size-4 text-ink-2" aria-hidden="true" />
        <span>{(c.getValue() as string | null) ?? 'Unnamed device'}</span>
        {c.row.original.isCurrent && <Badge tone="accent">This device</Badge>}
      </div>
    ),
  },
  { accessorKey: 'os', header: 'OS', cell: (c) => (c.getValue() as string | null) ?? '—' },
  {
    accessorKey: 'browser',
    header: 'Browser',
    cell: (c) => (c.getValue() as string | null) ?? '—',
  },
  {
    accessorKey: 'lastSeenAt',
    header: 'Last seen',
    cell: (c) => formatDate(c.getValue() as string),
  },
];

export function DevicesCard() {
  const queryClient = useQueryClient();

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/devices');
      if (error) throw error;
      return data;
    },
  });

  const revokeDeviceMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/devices/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Device revoked');
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) =>
      toast.error("Couldn't revoke the device", { description: apiErrorMessage(error) }),
  });

  return (
    <Card>
      <CardContent className="pt-5">
        <DataTable
          columns={deviceColumns}
          data={devicesQuery.data ?? []}
          isLoading={devicesQuery.isLoading}
          isError={devicesQuery.isError}
          onRetry={() => void devicesQuery.refetch()}
          emptyTitle="No devices signed in"
          getRowId={(row) => row.id}
          rowActions={(row) =>
            !row.isCurrent && (
              <Button
                size="sm"
                variant="outline"
                loading={
                  revokeDeviceMutation.isPending && revokeDeviceMutation.variables === row.id
                }
                onClick={() => revokeDeviceMutation.mutate(row.id)}
              >
                Revoke
              </Button>
            )
          }
        />
      </CardContent>
    </Card>
  );
}
