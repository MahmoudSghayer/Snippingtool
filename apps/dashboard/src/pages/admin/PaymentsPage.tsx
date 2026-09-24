import {
  PAYMENT_CLAIM_STATUSES,
  type AdminPaymentClaimDto,
  type PaymentClaimStatus,
} from '@sl/shared';
import {
  Button,
  DataTable,
  formatCurrencyFromCents,
  formatDateTime,
  IconButton,
  Modal,
  PageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { PaymentClaimStatusBadge } from '@/components/PaymentClaims.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';
import { usePermission } from '@/lib/permissions.js';

const ALL = 'all';
type StatusFilter = PaymentClaimStatus | typeof ALL;

const FILTER_LABELS: Record<StatusFilter, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  all: 'All',
};

/** Every query under this key is refreshed after an approve/reject,
 * including the nav's pending-count badge (routes/layouts.tsx). */
export const ADMIN_PAYMENT_CLAIMS_KEY = ['admin', 'payment-claims'] as const;

function money(claim: Pick<AdminPaymentClaimDto, 'amountCents' | 'currency'>): string {
  return formatCurrencyFromCents(claim.amountCents, claim.currency.toUpperCase());
}

function CopyTransactionId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-xs">{value}</span>
      <IconButton
        size="sm"
        variant="ghost"
        label={copied ? 'Copied' : `Copy transaction ID ${value}`}
        icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error('Couldn’t copy. Select the ID and copy it by hand.'),
          );
        }}
      />
    </div>
  );
}

const columns: ColumnDef<AdminPaymentClaimDto, unknown>[] = [
  {
    id: 'user',
    header: 'User',
    accessorFn: (row) => row.user.email,
  },
  {
    accessorKey: 'planName',
    header: 'Plan',
    cell: (c) => (c.getValue() as string | null) ?? c.row.original.planCode,
  },
  {
    accessorKey: 'amountCents',
    header: 'Amount',
    cell: (c) => <span className="font-mono tabular-nums">{money(c.row.original)}</span>,
  },
  {
    accessorKey: 'paypalTransactionId',
    header: 'PayPal transaction ID',
    cell: (c) => <CopyTransactionId value={c.getValue() as string} />,
  },
  {
    accessorKey: 'createdAt',
    header: 'Submitted',
    cell: (c) => formatDateTime(c.getValue() as string),
  },
  {
    accessorKey: 'note',
    header: 'Note',
    cell: (c) => {
      const note = c.getValue() as string | null;
      return note ? (
        <span className="line-clamp-2 max-w-64 text-xs" title={note}>
          {note}
        </span>
      ) : (
        <span className="text-ink-2">—</span>
      );
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => {
      const claim = c.row.original;
      return (
        <div className="flex flex-col items-start gap-1">
          <PaymentClaimStatusBadge status={claim.status} />
          {claim.rejectReason && <span className="text-xs text-ink-2">{claim.rejectReason}</span>}
        </div>
      );
    },
  },
];

/** `/admin/payments` — the queue of PayPal transaction IDs buyers submitted.
 * An admin checks each one against the PayPal account, then approves it
 * (which issues or extends the pass) or rejects it with a reason the buyer
 * sees. Reading needs `subscriptions.read`; acting needs
 * `subscriptions.write`. */
export function PaymentsPage() {
  const queryClient = useQueryClient();
  const canWrite = usePermission('subscriptions.write');
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [approveTarget, setApproveTarget] = useState<AdminPaymentClaimDto | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminPaymentClaimDto | null>(null);

  const listQuery = useQuery({
    queryKey: [...ADMIN_PAYMENT_CLAIMS_KEY, 'list', status, cursor],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/payment-claims', {
        params: { query: { status: status === ALL ? undefined : status, cursor, limit: 50 } },
      });
      if (error) throw error;
      return data;
    },
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ADMIN_PAYMENT_CLAIMS_KEY });
  }

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.POST('/api/v1/admin/payment-claims/{id}/approve', {
        params: { path: { id } },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Payment approved', { description: 'The pass has been issued or extended.' });
      setApproveTarget(null);
      refresh();
    },
    onError: (error) =>
      toast.error('Couldn’t approve the payment', { description: apiErrorMessage(error) }),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await api.POST('/api/v1/admin/payment-claims/{id}/reject', {
        params: { path: { id } },
        body: { reason },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Payment rejected');
      setRejectTarget(null);
      refresh();
    },
    onError: (error) =>
      toast.error('Couldn’t reject the payment', { description: apiErrorMessage(error) }),
  });

  function changeStatus(next: string) {
    setStatus(next as StatusFilter);
    setCursor(undefined);
    setCursorStack([]);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payments"
        description="PayPal transaction IDs submitted by buyers. Check each one in the PayPal account before approving."
      />

      <Tabs value={status} onValueChange={changeStatus}>
        <TabsList aria-label="Filter by status">
          {([...PAYMENT_CLAIM_STATUSES, ALL] as const).map((s) => (
            <TabsTrigger key={s} value={s}>
              {FILTER_LABELS[s]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable
        columns={columns}
        data={listQuery.data?.items ?? []}
        isLoading={listQuery.isLoading}
        isError={listQuery.isError}
        onRetry={() => void listQuery.refetch()}
        emptyTitle={status === 'pending' ? 'Nothing waiting for review' : 'No payments here'}
        getRowId={(row) => row.id}
        rowActions={
          canWrite
            ? (row) =>
                row.status === 'pending' && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setApproveTarget(row)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejectTarget(row)}>
                      Reject
                    </Button>
                  </div>
                )
            : undefined
        }
        hasNextPage={!!listQuery.data?.nextCursor}
        hasPreviousPage={cursorStack.length > 0}
        onNextPage={() => {
          if (!listQuery.data?.nextCursor) return;
          setCursorStack((s) => [...s, cursor ?? '']);
          setCursor(listQuery.data.nextCursor);
        }}
        onPreviousPage={() => {
          setCursorStack((s) => {
            const next = [...s];
            const prev = next.pop();
            setCursor(prev || undefined);
            return next;
          });
        }}
      />

      <Modal
        open={!!approveTarget}
        onOpenChange={(open) => !open && setApproveTarget(null)}
        title="Approve payment"
        description="Check the PayPal account first. Only approve if a payment with this transaction ID and this amount has arrived."
        footer={
          <>
            <Button variant="outline" onClick={() => setApproveTarget(null)}>
              Cancel
            </Button>
            <Button
              loading={approveMutation.isPending}
              onClick={() => approveTarget && approveMutation.mutate(approveTarget.id)}
            >
              I checked PayPal, approve
            </Button>
          </>
        }
      >
        {approveTarget && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-2">Transaction ID</dt>
            <dd className="font-mono">{approveTarget.paypalTransactionId}</dd>
            <dt className="text-ink-2">Amount</dt>
            <dd className="font-mono">{money(approveTarget)}</dd>
            <dt className="text-ink-2">Plan</dt>
            <dd>{approveTarget.planName ?? approveTarget.planCode}</dd>
            <dt className="text-ink-2">User</dt>
            <dd>{approveTarget.user.email}</dd>
          </dl>
        )}
      </Modal>

      <ReasonDialog
        open={!!rejectTarget}
        onOpenChange={(open) => !open && setRejectTarget(null)}
        title="Reject payment"
        description={
          rejectTarget
            ? `${rejectTarget.paypalTransactionId} · ${money(rejectTarget)} · ${rejectTarget.user.email}. The buyer sees this reason.`
            : undefined
        }
        confirmLabel="Reject payment"
        destructive
        loading={rejectMutation.isPending}
        onConfirm={(reason) =>
          rejectTarget && rejectMutation.mutate({ id: rejectTarget.id, reason })
        }
      />
    </div>
  );
}

export default PaymentsPage;
