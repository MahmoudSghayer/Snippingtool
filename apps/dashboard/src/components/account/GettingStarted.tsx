// "Getting started" on /account: five first steps, each ticked from data
// the API already returns. Every step reads its own query, so one that is
// slow or fails only affects its own row. The section disappears once all
// five are done, or when the customer hides it (remembered in this
// browser's localStorage).
import { Button, Card, CardContent } from '@sl/ui';
import { useMutation } from '@tanstack/react-query';
import { Circle, CircleCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage, isApiErrorBody } from '@/api/client.js';
import { describePass } from '@/components/account/PassSummary.js';
import {
  useDevices,
  useHasTrades,
  useMySubscription,
  useSavedFilters,
} from '@/components/account/queries.js';
import { StarterFilters } from '@/components/account/StarterFilters.js';
import { useAuthStore } from '@/stores/auth.js';

export const GETTING_STARTED_HIDDEN_KEY = 'sl.account.gettingStarted.hidden';

/** The API's "your plan doesn't include this" code; filters are a paid
 * feature, so a customer without a pass may get it from GET /filters. */
const FEATURE_NOT_IN_PLAN = 'FEATURE_NOT_IN_PLAN';

function readHidden(): boolean {
  try {
    return localStorage.getItem(GETTING_STARTED_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(): void {
  try {
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, '1');
  } catch {
    // Storage blocked (private window, site data off): hide for this visit only.
  }
}

type StepState =
  | { kind: 'loading' }
  | { kind: 'error'; retry: () => void }
  | { kind: 'done' }
  | { kind: 'todo' };

interface StepQuery<T> {
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
  refetch: () => unknown;
}

function stateFrom<T>(query: StepQuery<T>, isDone: (data: T) => boolean): StepState {
  if (query.isError) return { kind: 'error', retry: () => void query.refetch() };
  if (query.isPending || query.data === undefined) return { kind: 'loading' };
  return isDone(query.data) ? { kind: 'done' } : { kind: 'todo' };
}

function AnchorAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-sm text-gold underline underline-offset-2 hover:text-gold/80">
      {children}
    </a>
  );
}

function ResendVerification() {
  const email = useAuthStore((s) => s.user?.email ?? '');
  const resend = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/auth/resend-verification', { body: { email } });
      if (error) throw error;
    },
    onSuccess: () => toast.success('Verification email sent. Check your inbox.'),
    onError: (error) =>
      toast.error("Couldn't send the email", { description: apiErrorMessage(error) }),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      loading={resend.isPending}
      disabled={!email}
      onClick={() => resend.mutate()}
    >
      Resend verification email
    </Button>
  );
}

interface StepProps {
  title: string;
  state: StepState;
  /** What to do next; shown only while the step is not done. */
  action: React.ReactNode;
  /** Replaces the error/retry row, e.g. "Included with a pass". */
  note?: React.ReactNode;
}

function Step({ title, state, action, note }: StepProps) {
  const titleId = useId();
  const statusId = useId();
  const done = state.kind === 'done';
  const Icon = done ? CircleCheck : Circle;

  let body: React.ReactNode = null;
  if (note) body = note;
  else if (state.kind === 'loading') body = <span className="text-sm text-ink-2">Checking…</span>;
  else if (state.kind === 'error')
    body = (
      <span className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
        Couldn't check this step.
        <Button size="sm" variant="outline" onClick={state.retry}>
          Retry
        </Button>
      </span>
    );
  else if (state.kind === 'todo') body = action;

  return (
    <li aria-labelledby={`${titleId} ${statusId}`} className="flex gap-3 py-3">
      <Icon
        aria-hidden="true"
        className={done ? 'mt-0.5 size-5 shrink-0 text-gold' : 'mt-0.5 size-5 shrink-0 text-ink-2'}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          id={titleId}
          className={done ? 'text-sm text-ink-2 line-through' : 'text-sm font-medium text-ink'}
        >
          {title}
        </span>
        <span id={statusId} className="sr-only">
          {done ? 'done' : 'not done'}
        </span>
        {!done && body}
      </div>
    </li>
  );
}

function StarterFiltersCard() {
  return (
    <section id="starter-filters" aria-labelledby="starter-filters-title" className="scroll-mt-24">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <h2 id="starter-filters-title" className="text-base font-semibold text-ink">
            Starter filters
          </h2>
          <StarterFilters />
        </CardContent>
      </Card>
    </section>
  );
}

export function GettingStarted() {
  const [hidden, setHidden] = useState(readHidden);
  const emailVerifiedAt = useAuthStore((s) => s.user?.emailVerifiedAt);
  const subscriptionQuery = useMySubscription();
  const devicesQuery = useDevices();
  const filtersQuery = useSavedFilters();
  const tradesQuery = useHasTrades();

  const filtersNotInPlan =
    filtersQuery.isError &&
    isApiErrorBody(filtersQuery.error) &&
    filtersQuery.error.code === FEATURE_NOT_IN_PLAN;

  const email: StepState = emailVerifiedAt ? { kind: 'done' } : { kind: 'todo' };
  const pass = stateFrom(subscriptionQuery, (d) => describePass(d.subscription ?? null).live);
  const device = stateFrom(devicesQuery, (d) => d.some((x) => x.status === 'active'));
  const filters: StepState = filtersNotInPlan
    ? { kind: 'todo' }
    : stateFrom(filtersQuery, (d) => d.length > 0);
  const trade = stateFrom(tradesQuery, (d) => d);

  const states = [email, pass, device, filters, trade];
  const doneCount = states.filter((s) => s.kind === 'done').length;

  if (hidden) {
    // The checklist is gone, but a customer with no searches yet still gets
    // the starters.
    return filtersQuery.data?.length === 0 ? <StarterFiltersCard /> : null;
  }
  if (doneCount === states.length) return null;

  return (
    <section id="getting-started" aria-labelledby="getting-started-title" className="scroll-mt-24">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-gold">
            Start here
          </p>
          <h2
            id="getting-started-title"
            className="mt-1 text-xl font-bold tracking-tight text-ink sm:text-2xl"
          >
            Getting started
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            {doneCount} of {states.length} done
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Hide getting started"
          onClick={() => {
            writeHidden();
            setHidden(true);
          }}
        >
          Hide
        </Button>
      </div>
      <Card>
        <CardContent className="pt-2">
          <ol className="flex flex-col divide-y divide-line">
            <Step title="Verify your email" state={email} action={<ResendVerification />} />
            <Step
              title="Get a pass"
              state={pass}
              action={<AnchorAction href="#pass">Start a free trial or buy a pass</AnchorAction>}
            />
            <Step
              title="Install the extension and sign in"
              state={device}
              action={<AnchorAction href="#extension">Get the extension</AnchorAction>}
            />
            <Step
              title="Add a search filter"
              state={filters}
              action={<StarterFilters />}
              note={
                filtersNotInPlan ? (
                  <span className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                    Included with a pass
                    <AnchorAction href="#buy">See passes</AnchorAction>
                  </span>
                ) : undefined
              }
            />
            <Step
              title="Record your first trade"
              state={trade}
              action={
                <span className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
                  Your first buy through the extension shows up here.
                  <AnchorAction href="#extension">Open the extension guide</AnchorAction>
                </span>
              }
            />
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}
