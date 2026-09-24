// "Buy or renew" on /account: pay with PayPal (step 1), send us the
// transaction ID (step 2), and the list of payments already sent. The
// PayPal link, claim form and status chip come from PaymentClaims.tsx.
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  DataTable,
  formatCurrencyFromCents,
  formatDate,
  formatDateTime,
  cn,
  type ColumnDef,
} from '@sl/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';

import { api } from '@/api/client.js';
import { useMySubscription, usePlans } from '@/components/account/queries.js';
import {
  catalogueEntry,
  passLengthLabel,
  PaymentClaimForm,
  PaymentClaimStatusBadge,
  paypalUrlForPlan,
  purchasablePlans,
  shownPlans,
} from '@/components/PaymentClaims.js';

import type { PaymentClaimDto, PlanDto } from '@sl/shared';

/** Styled like `<Button>` (primary, sm). PayPal is an external link, so
 * it's an `<a>`, not a button that navigates. */
const LINK_BUTTON_CLASSES =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-(--sl-radius-sm) bg-(--sl-accent) px-3 text-sm font-medium text-(--sl-accent-ink) hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-bg)';

const claimColumns: ColumnDef<PaymentClaimDto, unknown>[] = [
  {
    accessorKey: 'createdAt',
    header: 'Submitted',
    cell: (c) => formatDateTime(c.getValue() as string),
  },
  {
    accessorKey: 'planName',
    header: 'Plan',
    cell: (c) => (c.getValue() as string | null) ?? c.row.original.planCode,
  },
  {
    accessorKey: 'amountCents',
    header: 'Amount',
    cell: (c) =>
      formatCurrencyFromCents(c.getValue() as number, c.row.original.currency.toUpperCase()),
  },
  {
    accessorKey: 'paypalTransactionId',
    header: 'Transaction ID',
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => {
      const claim = c.row.original;
      return (
        <div className="flex flex-col items-start gap-1">
          <PaymentClaimStatusBadge status={claim.status} />
          {claim.status === 'rejected' && claim.rejectReason && (
            <span className="text-xs text-ink-2">{claim.rejectReason}</span>
          )}
          {claim.reviewedAt && (
            <span className="text-xs text-ink-2">Reviewed {formatDate(claim.reviewedAt)}</span>
          )}
        </div>
      );
    },
  },
];

function PlanCard({ plan, current }: { plan: PlanDto; current: boolean }) {
  const entry = catalogueEntry(plan.code);
  if (!entry) return null;
  const available = entry.availability === 'available';
  const price = formatCurrencyFromCents(plan.priceCents, plan.currency.toUpperCase());

  return (
    <Card className={cn('bg-surface-2', current && 'border-gold', !available && 'opacity-80')}>
      <CardHeader>
        <CardTitle>{plan.name}</CardTitle>
        {current ? (
          <Badge tone="accent">Current</Badge>
        ) : (
          !available && <Badge tone="neutral">Coming soon</Badge>
        )}
      </CardHeader>
      <CardContent>
        <p className="font-mono text-2xl font-semibold text-ink">{price}</p>
        <ul className="mt-3 flex flex-col gap-1 text-xs text-ink-2">
          <li>{passLengthLabel(entry)}, doesn't renew</li>
          <li>
            {plan.deviceLimit} device{plan.deviceLimit > 1 ? 's' : ''}
          </li>
          <li>Automation included</li>
          {plan.features.includes('mobile.remote') && <li>Mobile companion</li>}
        </ul>
      </CardContent>
      <CardFooter>
        {available ? (
          <a
            href={paypalUrlForPlan(plan)}
            target="_blank"
            rel="noopener"
            className={LINK_BUTTON_CLASSES}
          >
            Pay with PayPal
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <Button size="sm" disabled>
            Coming soon
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/** Step 1: the plan cards, each with its PayPal link. */
export function PayWithPayPal() {
  const plansQuery = usePlans();
  const subscriptionQuery = useMySubscription();
  const currentCode = subscriptionQuery.data?.subscription?.plan.code;
  const planCards = shownPlans(plansQuery.data?.items ?? []);

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Step 1 · Pay with PayPal</CardTitle>
        <p className="text-xs text-ink-2">
          Pick a plan and pay with PayPal. Buying another pass extends the one you have.
        </p>
      </CardHeader>
      <CardContent>
        {plansQuery.isError ? (
          <div className="flex items-center gap-3 text-sm text-ink-2">
            Couldn't load plans.
            <Button size="sm" variant="outline" onClick={() => void plansQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : plansQuery.isLoading ? (
          <p className="text-sm text-ink-2">Loading plans…</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {planCards.map((plan) => (
              <PlanCard key={plan.id} plan={plan} current={plan.code === currentCode} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Step 2: send the PayPal transaction ID for review. */
export function SubmitPayment() {
  const queryClient = useQueryClient();
  const plansQuery = usePlans();

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Step 2 · Already paid? Send us your PayPal transaction ID</CardTitle>
        <p className="text-xs text-ink-2">
          We check payments by hand, usually within a few hours. Your pass starts when the payment
          is approved.
        </p>
      </CardHeader>
      <CardContent>
        {plansQuery.isLoading ? (
          <p className="text-sm text-ink-2">Loading plans…</p>
        ) : (
          <PaymentClaimForm
            plans={purchasablePlans(plansQuery.data?.items ?? [])}
            onSubmitted={() => void queryClient.invalidateQueries({ queryKey: ['payment-claims'] })}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The payments this account has sent in, newest first. */
export function PaymentHistory() {
  const claimsQuery = useQuery({
    queryKey: ['payment-claims'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/payment-claims');
      if (error) throw error;
      return data;
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your payments</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={claimColumns}
          data={claimsQuery.data?.items ?? []}
          isLoading={claimsQuery.isLoading}
          isError={claimsQuery.isError}
          onRetry={() => void claimsQuery.refetch()}
          emptyTitle="No payments sent yet"
          getRowId={(row) => row.id}
        />
      </CardContent>
    </Card>
  );
}
