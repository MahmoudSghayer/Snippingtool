// Shared "manage this user's subscription" panel — used by both the
// `/admin/users` detail drawer's Subscription tab and the `/admin/subscriptions`
// list's row drawer (docs/07-dashboard.md §11 gap #2). Resolves the live
// subscription id via `GET /admin/subscriptions/by-user/:userId` so
// extend/suspend/unsuspend/cancel/device-limit are reachable from a bare
// `userId`, not just activate/grant-lifetime.
import { Badge, Button, FormField, Input, Select } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { usePermission } from '@/lib/permissions.js';

import { ReasonDialog } from './ReasonDialog.js';

const statusTone: Record<string, 'positive' | 'negative' | 'warning' | 'neutral'> = {
  active: 'positive',
  trialing: 'positive',
  lifetime: 'positive',
  past_due: 'warning',
  suspended: 'warning',
  canceled: 'negative',
  expired: 'negative',
};

export function SubscriptionActions({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const canWrite = usePermission('subscriptions.write');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [deviceLimitOpen, setDeviceLimitOpen] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [lifetimeOpen, setLifetimeOpen] = useState(false);
  const [periodDays, setPeriodDays] = useState(30);
  const [maxDevices, setMaxDevices] = useState(2);
  const [planCode, setPlanCode] = useState('pro');
  const [immediate, setImmediate] = useState(false);

  const subQuery = useQuery({
    queryKey: ['admin', 'subscriptions', 'by-user', userId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/subscriptions/by-user/{userId}', { params: { path: { userId } } });
      if (error) throw error;
      return data;
    },
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions', 'by-user', userId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions', 'list'] });
  }

  const current = subQuery.data?.current ?? null;
  const licenseId = subQuery.data?.currentLicenseId ?? null;

  const extendMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!current) return;
      const { error } = await api.POST('/api/v1/admin/subscriptions/{id}/extend', { params: { path: { id: current.id } }, body: { periodDays, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription extended');
      setExtendOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't extend subscription", { description: apiErrorMessage(error) }),
  });

  const suspendMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!current) return;
      const path = current.status === 'suspended' ? '/api/v1/admin/subscriptions/{id}/unsuspend' : '/api/v1/admin/subscriptions/{id}/suspend';
      const { error } = await api.POST(path, { params: { path: { id: current.id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(current?.status === 'suspended' ? 'Subscription unsuspended' : 'Subscription suspended');
      setSuspendOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('Action failed', { description: apiErrorMessage(error) }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!current) return;
      const { error } = await api.POST('/api/v1/admin/subscriptions/{id}/cancel', { params: { path: { id: current.id } }, body: { reason, immediate } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription canceled');
      setCancelOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't cancel subscription", { description: apiErrorMessage(error) }),
  });

  const deviceLimitMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!licenseId) return;
      const { error } = await api.POST('/api/v1/admin/licenses/{id}/device-limit', { params: { path: { id: licenseId } }, body: { maxDevices, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Device limit updated');
      setDeviceLimitOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't update device limit", { description: apiErrorMessage(error) }),
  });

  const activateMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/subscriptions/{userId}/activate', { params: { path: { userId } }, body: { planCode, periodDays, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription activated');
      setActivateOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't activate subscription", { description: apiErrorMessage(error) }),
  });

  const grantLifetimeMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/subscriptions/{userId}/grant-lifetime', { params: { path: { userId } }, body: { planCode, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Lifetime access granted');
      setLifetimeOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't grant lifetime", { description: apiErrorMessage(error) }),
  });

  if (subQuery.isLoading) return <p className="text-sm text-ink-2">Loading…</p>;
  if (subQuery.isError) return <p className="text-sm text-risk">Couldn't load this user's subscription.</p>;

  return (
    <div className="flex flex-col gap-4">
      {current ? (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[current.status] ?? 'neutral'}>{current.status}</Badge>
            <span className="text-sm font-medium text-ink">{current.plan.name}</span>
            <span className="text-xs text-ink-2">({current.plan.code})</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-ink-2">
            <div>Period ends: {current.currentPeriodEnd ? new Date(current.currentPeriodEnd).toLocaleDateString() : '—'}</div>
            <div>Trial ends: {current.trialEndsAt ? new Date(current.trialEndsAt).toLocaleDateString() : '—'}</div>
            <div>Auto-renew: {current.autoRenew ? 'Yes' : 'No'}</div>
            <div>License device limit: {licenseId ? 'Managed' : 'No active license'}</div>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)}>
                Extend
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSuspendOpen(true)}>
                {current.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
              <Button size="sm" variant="outline" disabled={!licenseId} onClick={() => setDeviceLimitOpen(true)}>
                Device limit
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-2">This user has no live subscription.</p>
      )}

      {canWrite && !current && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Plan code" htmlFor="sa-planCode">
              <Input id="sa-planCode" value={planCode} onChange={(e) => setPlanCode(e.target.value)} />
            </FormField>
            <FormField label="Period (days)" htmlFor="sa-periodDays">
              <Input id="sa-periodDays" type="number" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setActivateOpen(true)}>
              Activate subscription
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLifetimeOpen(true)}>
              Grant lifetime
            </Button>
          </div>
        </div>
      )}

      <ReasonDialog
        open={extendOpen}
        onOpenChange={setExtendOpen}
        title={`Extend by ${periodDays}d`}
        confirmLabel="Extend"
        loading={extendMutation.isPending}
        onConfirm={(reason) => extendMutation.mutate(reason)}
        extraFields={
          <FormField label="Period (days)" htmlFor="extend-days">
            <Input id="extend-days" type="number" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} />
          </FormField>
        }
      />
      <ReasonDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={current?.status === 'suspended' ? 'Unsuspend subscription' : 'Suspend subscription'}
        destructive={current?.status !== 'suspended'}
        loading={suspendMutation.isPending}
        onConfirm={(reason) => suspendMutation.mutate(reason)}
      />
      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel subscription"
        destructive
        confirmLabel="Cancel subscription"
        loading={cancelMutation.isPending}
        onConfirm={(reason) => cancelMutation.mutate(reason)}
        extraFields={
          <FormField label="Timing" htmlFor="cancel-immediate">
            <Select
              value={immediate ? 'immediate' : 'period_end'}
              onValueChange={(v) => setImmediate(v === 'immediate')}
              options={[
                { value: 'period_end', label: 'At period end' },
                { value: 'immediate', label: 'Immediately' },
              ]}
            />
          </FormField>
        }
      />
      <ReasonDialog
        open={deviceLimitOpen}
        onOpenChange={setDeviceLimitOpen}
        title="Override device limit"
        confirmLabel="Save"
        loading={deviceLimitMutation.isPending}
        onConfirm={(reason) => deviceLimitMutation.mutate(reason)}
        extraFields={
          <FormField label="Max devices" htmlFor="device-limit">
            <Input id="device-limit" type="number" min={1} max={10} value={maxDevices} onChange={(e) => setMaxDevices(Number(e.target.value))} />
          </FormField>
        }
      />
      <ReasonDialog open={activateOpen} onOpenChange={setActivateOpen} title={`Activate ${planCode} for ${periodDays}d`} confirmLabel="Activate" loading={activateMutation.isPending} onConfirm={(reason) => activateMutation.mutate(reason)} />
      <ReasonDialog open={lifetimeOpen} onOpenChange={setLifetimeOpen} title={`Grant lifetime (${planCode})`} confirmLabel="Grant lifetime" loading={grantLifetimeMutation.isPending} onConfirm={(reason) => grantLifetimeMutation.mutate(reason)} />
    </div>
  );
}
