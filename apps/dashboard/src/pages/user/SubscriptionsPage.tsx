import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

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
  formatCoins,
  formatCurrencyFromCents,
  formatDate,
  FormField,
  Input,
  Modal,
  PageHeader,
  type ColumnDef,
} from '@sl/ui';
import type { CouponValidateResponse, DeviceDto, PlanDto } from '@sl/shared';

import { api, apiErrorMessage } from '@/api/client.js';

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
  { accessorKey: 'browser', header: 'Browser', cell: (c) => (c.getValue() as string | null) ?? '—' },
  { accessorKey: 'lastSeenAt', header: 'Last seen', cell: (c) => formatDate(c.getValue() as string) },
];

export function SubscriptionsPage() {
  const queryClient = useQueryClient();
  const [couponCode, setCouponCode] = useState('');
  const [couponResult, setCouponResult] = useState<CouponValidateResponse | null>(null);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const subscriptionQuery = useQuery({
    queryKey: ['subscription'],
    queryFn: async () => {
      const { data, error } = await api.GET('/subscriptions/me');
      if (error) throw error;
      return data;
    },
  });

  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { data, error } = await api.GET('/plans');
      if (error) throw error;
      return data;
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/devices');
      if (error) throw error;
      return data;
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: async (plan: PlanDto) => {
      const { data, error } = await api.POST('/payments/checkout', {
        body: {
          planCode: plan.code as never,
          successUrl: `${window.location.origin}/subscriptions?checkout=success`,
          cancelUrl: `${window.location.origin}/subscriptions?checkout=cancelled`,
          ...(couponResult?.valid ? { couponCode } : {}),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      window.location.assign(data.checkoutUrl);
    },
    onError: (error) => toast.error('Checkout failed', { description: apiErrorMessage(error) }),
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/payments/portal', { body: {} });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => window.location.assign(data.portalUrl),
    onError: (error) => toast.error("Couldn't open billing portal", { description: apiErrorMessage(error) }),
  });

  const trialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/subscriptions/trial', { body: {} });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Trial started');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (error) => toast.error("Couldn't start trial", { description: apiErrorMessage(error) }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/subscriptions/cancel', { body: {} });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Your subscription will end at the end of the current period.');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (error) => toast.error("Couldn't cancel", { description: apiErrorMessage(error) }),
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/subscriptions/resume', { body: {} });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription resumed');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (error) => toast.error("Couldn't resume", { description: apiErrorMessage(error) }),
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/licenses/regenerate', { body: {} });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setRevealedKey(data.licenseKey);
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['license'] });
    },
    onError: (error) => toast.error("Couldn't regenerate license", { description: apiErrorMessage(error) }),
  });

  const revokeDeviceMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/devices/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Device revoked');
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => toast.error("Couldn't revoke device", { description: apiErrorMessage(error) }),
  });

  async function handleValidateCoupon(planCode: string) {
    if (!couponCode.trim()) return;
    const { data, error } = await api.POST('/coupons/validate', { body: { code: couponCode.trim(), planCode: planCode as never } });
    if (error) {
      toast.error('Invalid coupon', { description: apiErrorMessage(error) });
      return;
    }
    setCouponResult(data);
    if (!data.valid) toast.error(`Coupon not applicable: ${data.reason}`);
    else toast.success(data.discountPreview ?? 'Coupon applied');
  }

  const subscription = subscriptionQuery.data?.subscription ?? null;
  const license = subscriptionQuery.data?.license ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Subscription" description="Manage your plan, license and devices." />

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
                  <Badge tone={subscription.status === 'active' || subscription.status === 'lifetime' ? 'positive' : subscription.status === 'past_due' ? 'warning' : 'neutral'}>
                    {subscription.status}
                  </Badge>
                  {subscription.cancelAtPeriodEnd && <Badge tone="warning">Ends at period end</Badge>}
                </div>
                {subscription.currentPeriodEnd && (
                  <p className="mt-1 text-xs text-ink-2">Renews / ends {formatDate(subscription.currentPeriodEnd)}</p>
                )}
                {subscription.trialEndsAt && <p className="mt-1 text-xs text-ink-2">Trial ends {formatDate(subscription.trialEndsAt)}</p>}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" loading={portalMutation.isPending} onClick={() => portalMutation.mutate()}>
                  Customer portal
                </Button>
                {subscription.status !== 'lifetime' &&
                  (subscription.cancelAtPeriodEnd ? (
                    <Button variant="outline" loading={resumeMutation.isPending} onClick={() => resumeMutation.mutate()}>
                      Resume
                    </Button>
                  ) : (
                    <Button variant="destructive" loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                      Cancel
                    </Button>
                  ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-2">You don't have an active subscription yet.</p>
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
                For security, the full key is only ever shown once — right after it's issued or regenerated. Regenerating
                immediately revokes the current key on every device.
              </p>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => setRegenerateOpen(true)}>
                Regenerate license key
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-2">A license key is issued once you have an active subscription or trial.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-end gap-2">
            <FormField label="Coupon code" htmlFor="coupon" className="max-w-xs">
              <Input id="coupon" value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())} placeholder="SAVE20" />
            </FormField>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(plansQuery.data ?? []).map((plan) => (
              <Card key={plan.id} className={plan.code === subscription?.plan.code ? 'border-gold' : undefined}>
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  {plan.code === subscription?.plan.code && <Badge tone="accent">Current</Badge>}
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-2xl font-semibold text-ink">
                    {formatCurrencyFromCents(plan.priceCents, plan.currency.toUpperCase())}
                    <span className="text-sm font-normal text-ink-2"> / {plan.isLifetime ? 'lifetime' : plan.interval}</span>
                  </p>
                  <ul className="mt-3 flex flex-col gap-1 text-xs text-ink-2">
                    <li>{plan.deviceLimit} device{plan.deviceLimit > 1 ? 's' : ''}</li>
                    {plan.features.slice(0, 4).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button size="sm" onClick={() => void handleValidateCoupon(plan.code)} variant="ghost" disabled={!couponCode}>
                    Apply coupon
                  </Button>
                  <Button size="sm" loading={checkoutMutation.isPending} onClick={() => checkoutMutation.mutate(plan)}>
                    Checkout
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
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
                <Button size="sm" variant="outline" loading={revokeDeviceMutation.isPending} onClick={() => revokeDeviceMutation.mutate(row.id)}>
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

export default SubscriptionsPage;
