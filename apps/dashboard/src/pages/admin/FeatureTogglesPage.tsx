import { Badge, Button, Card, CardContent, PageHeader, Switch } from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

import type { FeatureToggleDto } from '@sl/shared';

/** `/admin/feature-toggles` — includes the `kill_switch` toggle, which gets
 * an extra destructive confirm step (PHASE 7: "incl. kill switch with
 * confirm dialog") on top of the reason every toggle change already
 * requires. `PATCH /admin/toggles/:key`'s `reason` isn't part of
 * `updateFeatureToggleRequestSchema` (only `enabled`/`rolloutPercent`/
 * `planGate`), so this page's confirm step is a UX safeguard, not something
 * the API itself demands for this one endpoint. */
export function FeatureTogglesPage() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ toggle: FeatureToggleDto; enabled: boolean } | null>(
    null,
  );

  const togglesQuery = useQuery({
    queryKey: ['admin', 'toggles'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/toggles');
      if (error) throw error;
      return data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) => {
      const { error } = await api.PATCH('/api/v1/admin/toggles/{key}', {
        params: { path: { key } },
        body: { enabled },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Toggle updated');
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'toggles'] });
    },
    onError: (error) =>
      toast.error("Couldn't update toggle", { description: apiErrorMessage(error) }),
  });

  function handleToggle(toggle: FeatureToggleDto, enabled: boolean) {
    if (toggle.key === 'kill_switch') {
      setPending({ toggle, enabled });
      return;
    }
    updateMutation.mutate({ key: toggle.key, enabled });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Feature toggles" description="Kill switch and rollout gates." />

      <Card>
        <CardContent className="divide-y divide-line pt-5">
          {(togglesQuery.data ?? []).map((toggle) => (
            <div
              key={toggle.key}
              className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-sm text-ink">{toggle.key}</p>
                  {toggle.key === 'kill_switch' && <Badge tone="negative">Critical</Badge>}
                </div>
                <p className="text-xs text-ink-2">
                  Rollout {toggle.rolloutPercent}%{' '}
                  {toggle.planGate ? `· gated to ${toggle.planGate}` : ''}
                </p>
              </div>
              <Switch
                checked={toggle.enabled}
                onCheckedChange={(v) => handleToggle(toggle, v)}
                aria-label={toggle.key}
              />
            </div>
          ))}
          {togglesQuery.isLoading && <p className="py-3 text-sm text-ink-2">Loading…</p>}
          {togglesQuery.isError && (
            <div className="flex items-center justify-between py-3">
              <p className="text-sm text-ink-2">Couldn&apos;t load feature toggles.</p>
              <Button size="sm" variant="outline" onClick={() => void togglesQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.enabled ? 'Activate kill switch' : 'Deactivate kill switch'}
        description={
          pending?.enabled
            ? 'This immediately stops automation on every device via the safety governor. Confirm you intend to do this now.'
            : 'This re-enables automation for devices whose plan allows it.'
        }
        destructive={!!pending?.enabled}
        confirmLabel={pending?.enabled ? 'Activate kill switch' : 'Deactivate'}
        loading={updateMutation.isPending}
        onConfirm={() =>
          pending && updateMutation.mutate({ key: pending.toggle.key, enabled: pending.enabled })
        }
      />
    </div>
  );
}

export default FeatureTogglesPage;
