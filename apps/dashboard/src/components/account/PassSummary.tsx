// "Your pass" on /account: the current plan, its status and when it ends.
import { Badge, Button, Card, CardContent, type BadgeTone } from '@sl/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';
import { useMySubscription } from '@/components/account/queries.js';

import type { SubscriptionDto, SubscriptionStatus } from '@sl/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

const PASS_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "24 Oct 2026". */
export function formatPassDate(iso: string): string {
  return PASS_DATE.format(new Date(iso));
}

/** Whole days until `iso`, rounded up, never negative. */
export function daysLeft(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS));
}

function daysLeftLabel(days: number): string {
  if (days === 0) return 'ends today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment due',
  canceled: 'Cancelled',
  suspended: 'Suspended',
  expired: 'Expired',
  lifetime: 'Active',
};

const STATUS_TONE: Record<SubscriptionStatus, BadgeTone> = {
  trialing: 'accent',
  active: 'positive',
  past_due: 'warning',
  canceled: 'neutral',
  suspended: 'negative',
  expired: 'neutral',
  lifetime: 'positive',
};

export interface PassDescription {
  /** False when there's nothing the extension can run on. */
  live: boolean;
  /** "Active until 24 Oct 2026", "Trial until …", "No active pass". */
  headline: string;
  /** "12 days left", or null when there's no end date to count to. */
  detail: string | null;
}

/** Plain-language summary of a pass, used for the "Your pass" card. */
export function describePass(
  subscription: SubscriptionDto | null,
  now: Date = new Date(),
): PassDescription {
  if (!subscription) return { live: false, headline: 'No active pass', detail: null };

  switch (subscription.status) {
    case 'trialing': {
      const end = subscription.trialEndsAt ?? subscription.currentPeriodEnd;
      return end
        ? {
            live: true,
            headline: `Trial until ${formatPassDate(end)}`,
            detail: daysLeftLabel(daysLeft(end, now)),
          }
        : { live: true, headline: 'Free trial', detail: null };
    }
    case 'active':
    case 'past_due': {
      const end = subscription.currentPeriodEnd;
      return end
        ? {
            live: true,
            headline: `Active until ${formatPassDate(end)}`,
            detail: daysLeftLabel(daysLeft(end, now)),
          }
        : { live: true, headline: 'Active', detail: null };
    }
    case 'lifetime':
      return { live: true, headline: 'Active, no end date', detail: null };
    case 'suspended':
      return {
        live: false,
        headline: 'Your pass is suspended',
        detail: 'Contact support if you think this is a mistake.',
      };
    case 'canceled':
    case 'expired': {
      const end = subscription.currentPeriodEnd ?? subscription.trialEndsAt;
      return {
        live: false,
        headline: 'No active pass',
        detail: end ? `Your last pass ended ${formatPassDate(end)}.` : null,
      };
    }
  }
}

export function PassSummary() {
  const queryClient = useQueryClient();
  const subscriptionQuery = useMySubscription();

  const trialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/subscriptions/trial');
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Trial started');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['downloads', 'extension', 'info'] });
    },
    onError: (error) =>
      toast.error("Couldn't start the trial", { description: apiErrorMessage(error) }),
  });

  if (subscriptionQuery.isLoading) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-ink-2">Loading your pass…</CardContent>
      </Card>
    );
  }

  if (subscriptionQuery.isError) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 pt-5 text-sm text-ink-2">
          Couldn't load your pass.
          <Button size="sm" variant="outline" onClick={() => void subscriptionQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const subscription = subscriptionQuery.data?.subscription ?? null;
  const pass = describePass(subscription);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          {subscription && pass.live && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-semibold text-ink">{subscription.plan.name}</p>
              <Badge tone={STATUS_TONE[subscription.status]}>
                {STATUS_LABEL[subscription.status]}
              </Badge>
            </div>
          )}
          <p className={pass.live ? 'text-sm text-ink' : 'text-lg font-semibold text-ink'}>
            {pass.headline}
            {pass.live && pass.detail && <span className="text-ink-2"> · {pass.detail}</span>}
          </p>
          {!pass.live && pass.detail && <p className="text-sm text-ink-2">{pass.detail}</p>}
        </div>
        {subscription && pass.live ? (
          <a
            href="#buy"
            className="text-sm text-gold underline underline-offset-2 hover:text-gold/80"
          >
            Extend your pass
          </a>
        ) : subscription ? (
          <a
            href="#buy"
            className="text-sm text-gold underline underline-offset-2 hover:text-gold/80"
          >
            Buy a pass
          </a>
        ) : (
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Button loading={trialMutation.isPending} onClick={() => trialMutation.mutate()}>
              Start 7-day free trial
            </Button>
            <a
              href="#buy"
              className="text-sm text-gold underline underline-offset-2 hover:text-gold/80"
            >
              or buy a pass
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
