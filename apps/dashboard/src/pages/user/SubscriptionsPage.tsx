import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CopyField,
  DataTable,
  formatCurrencyFromCents,
  formatDate,
  formatDateTime,
  Modal,
  PageHeader,
  cn,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Laptop, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { ExtensionDownloadCard, useExtensionDownloadInfo } from '@/components/ExtensionDownload.js';
import {
  catalogueEntry,
  passLengthLabel,
  PaymentClaimForm,
  PaymentClaimStatusBadge,
  paypalUrlForPlan,
  purchasablePlans,
  shownPlans,
} from '@/components/PaymentClaims.js';

import type { DeviceDto, PaymentClaimDto, PlanDto } from '@sl/shared';

/** Styled like `<Button>` (primary, sm) — PayPal is an external link, so
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

const deviceColumns: ColumnDef<DeviceDto, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Device',
    cell: (c) => (
      <div className="flex items-center gap-2">
        <Laptop className="size-4 text-ink-2" />
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

export function SubscriptionsPage() {
  const queryClient = useQueryClient();
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const subscriptionQuery = useQuery({
    queryKey: ['subscription'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/subscriptions/me');
      if (error) throw error;
      return data;
    },
  });

  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/plans');
      if (error) throw error;
      return data;
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/devices');
      if (error) throw error;
      return data;
    },
  });

  const claimsQuery = useQuery({
    queryKey: ['payment-claims'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/payment-claims');
      if (error) throw error;
      return data;
    },
  });

  const trialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/subscriptions/trial');
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Trial started');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (error) =>
      toast.error("Couldn't start trial", { description: apiErrorMessage(error) }),
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/licenses/regenerate');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setRevealedKey(data.licenseKey);
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['license'] });
    },
    onError: (error) =>
      toast.error("Couldn't regenerate license", { description: apiErrorMessage(error) }),
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
      toast.error("Couldn't revoke device", { description: apiErrorMessage(error) }),
  });

  // Entitled users came here to get the extension, so it goes first; everyone
  // else sees the short "comes with a pass" card next to the plans.
  const extensionInfoQuery = useExtensionDownloadInfo();
  const extensionEntitled = extensionInfoQuery.data?.entitled === true;

  const subscription = subscriptionQuery.data?.subscription ?? null;
  const license = subscriptionQuery.data?.license ?? null;
  const allPlans = plansQuery.data?.items ?? [];
  const planCards = shownPlans(allPlans);
  const buyablePlans = purchasablePlans(allPlans);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Subscription" description="Your pass, payments, license and devices." />

      {extensionEntitled && <ExtensionDownloadCard />}

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-lg font-semibold text-ink">{subscription.plan.name}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge
                    tone={
                      subscription.status === 'active' || subscription.status === 'lifetime'
                        ? 'positive'
                        : subscription.status === 'past_due'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {subscription.status}
                  </Badge>
                </div>
                {subscription.status !== 'trialing' && subscription.currentPeriodEnd && (
                  <p className="mt-1 text-xs text-ink-2">
                    Pass ends {formatDate(subscription.currentPeriodEnd)}
                  </p>
                )}
                {subscription.status === 'trialing' && subscription.trialEndsAt && (
                  <p className="mt-1 text-xs text-ink-2">
                    Trial ends {formatDate(subscription.trialEndsAt)}
                  </p>
                )}
              </div>
              <p className="text-xs text-ink-2 sm:max-w-xs sm:text-right">
                Passes don't renew automatically. Buy another pass below to extend it.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-2">You don't have an active pass yet.</p>
              <Button loading={trialMutation.isPending} onClick={() => trialMutation.mutate()}>
                Start 7-day free trial
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>License</CardTitle>
          <ShieldCheck className="size-4 text-ink-2" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {license ? (
            <>
              <CopyField label="License key prefix" value={`${license.keyPrefix}…`} />
              <p className="text-xs text-ink-2">
                For security, the full key is only ever shown once — right after it's issued or
                regenerated. Regenerating immediately revokes the current key on every device.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setRegenerateOpen(true)}
              >
                Regenerate license key
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-2">
              A license key is issued once you have an active subscription or trial.
            </p>
          )}
        </CardContent>
      </Card>

      {!extensionEntitled && <ExtensionDownloadCard />}

      <Card id="pricing" className="scroll-mt-6">
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Step 1 · Pay with PayPal</CardTitle>
          <p className="text-xs text-ink-2">
            Passes don't renew automatically. Automation is included on every paid plan. Refunds
            only within 24 hours of purchase, see the{' '}
            <a
              href="/refund-policy"
              target="_blank"
              rel="noopener"
              className="text-gold underline underline-offset-2 hover:text-gold/80"
            >
              Refund Policy
            </a>
            .
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
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {planCards.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  current={plan.code === subscription?.plan.code}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Step 2 · Already paid? Submit your PayPal transaction ID</CardTitle>
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
              plans={buyablePlans}
              onSubmitted={() =>
                void queryClient.invalidateQueries({ queryKey: ['payment-claims'] })
              }
            />
          )}
        </CardContent>
      </Card>

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
            emptyTitle="No payments submitted yet"
            getRowId={(row) => row.id}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={deviceColumns}
            data={devicesQuery.data ?? []}
            isLoading={devicesQuery.isLoading}
            isError={devicesQuery.isError}
            onRetry={() => void devicesQuery.refetch()}
            emptyTitle="No devices registered"
            getRowId={(row) => row.id}
            rowActions={(row) =>
              !row.isCurrent && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={revokeDeviceMutation.isPending}
                  onClick={() => revokeDeviceMutation.mutate(row.id)}
                >
                  Revoke
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Modal
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
        title="Regenerate license key"
        description="This immediately revokes the current key on every device. You'll need to update it wherever it's used."
        footer={
          <>
            <Button variant="outline" onClick={() => setRegenerateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={regenerateMutation.isPending}
              onClick={() => regenerateMutation.mutate()}
            >
              Regenerate
            </Button>
          </>
        }
      >
        {revealedKey ? (
          <div className="flex flex-col gap-2">
            <CopyField label="New license key (shown once)" value={revealedKey} />
            <p className="text-xs text-ink-2">Copy this now — it will never be shown again.</p>
          </div>
        ) : (
          <p className="text-sm text-ink-2">Are you sure? This cannot be undone.</p>
        )}
      </Modal>
    </div>
  );
}

function PlanCard({ plan, current }: { plan: PlanDto; current: boolean }) {
  const entry = catalogueEntry(plan.code);
  if (!entry) return null;
  const available = entry.availability === 'available';
  const price = formatCurrencyFromCents(plan.priceCents, plan.currency.toUpperCase());

  return (
    <Card className={cn(current && 'border-gold', !available && 'opacity-80')}>
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

export default SubscriptionsPage;
