// The Market view (docs/14-ml-suggestions.md Phase B), rendered as a tab of
// the Bot page rather than its own route — what is trading and what the bot
// is set to look for belong next to each other.
//
// There is no prediction here. Every number is an aggregate over observed
// listings the extension already reports, which is what makes this useful
// before any model exists and is what generates the history the later phases
// need.
//
// The scope switch is the part worth understanding: `mine` is the caller's
// own observations, always available; `market` is the pooled cross-user view
// and is subject to a minimum-contributor threshold, so it can legitimately
// be empty while `mine` has data. The API says which of those happened, and
// this component shows that reason instead of an unexplained blank — "no
// rows" reading as "quiet market" is exactly how a broken pipeline hides.

import {
  Badge,
  Button,
  Card,
  CardContent,
  DataTable,
  EmptyState,
  formatCoins,
  formatDate,
  Select,
  type ColumnDef,
} from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client.js';
import { EventsTimeline } from '@/pages/user/EventsTimeline.js';

type MarketWindow = '1h' | '24h' | '7d' | '30d';
type MarketScope = 'mine' | 'market';

interface Meta {
  scope: MarketScope;
  window: MarketWindow;
  contributors: number | null;
  suppressedForPrivacy: boolean;
  emptyReason: string | null;
}

interface ActivityRow {
  resourceId: string;
  name: string | null;
  rating: number | null;
  attempts: number;
  successes: number;
  successRate: number | null;
  medianListedPrice: number | null;
  minListedPrice: number | null;
  maxListedPrice: number | null;
  lastSeenAt: string;
}

interface MoverRow {
  resourceId: string;
  name: string | null;
  rating: number | null;
  currentMedian: number;
  previousMedian: number;
  changePct: number;
  currentSamples: number;
  previousSamples: number;
}

const WINDOWS: { value: MarketWindow; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const SCOPES: { value: MarketScope; label: string }[] = [
  { value: 'mine', label: 'My observations' },
  { value: 'market', label: 'Pooled market' },
];

const coins = (value: number | null) => (value == null ? '—' : formatCoins(value));

function cardLabel(row: { name: string | null; rating: number | null; resourceId: string }) {
  // A card the collectors have never described still has observations, so
  // fall back to the resource id rather than rendering a blank row.
  if (!row.name) return <span className="font-mono text-xs">{row.resourceId}</span>;
  return (
    <span>
      {row.name}
      {row.rating != null && (
        <span className="ml-2 text-xs text-(--sl-fg-muted)">{row.rating}</span>
      )}
    </span>
  );
}

/** Shown whenever a list comes back empty, carrying the API's own reason. */
function EmptyWithReason({ meta, kind }: { meta: Meta | undefined; kind: string }) {
  const reason = meta?.emptyReason ?? `No ${kind} to show yet.`;
  return (
    <EmptyState
      title={meta?.suppressedForPrivacy ? 'Withheld for privacy' : `No ${kind} yet`}
      description={
        meta?.suppressedForPrivacy
          ? `${reason}. Pooled figures appear once enough separate people have observed the same card.`
          : reason
      }
    />
  );
}

export function MarketPanel() {
  const [window, setWindow] = useState<MarketWindow>('24h');
  const [scope, setScope] = useState<MarketScope>('mine');

  const activityQuery = useQuery({
    queryKey: ['market', 'activity', window, scope],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/market/activity', {
        params: { query: { window, scope } },
      });
      if (error) throw error;
      return data;
    },
  });

  const moversQuery = useQuery({
    queryKey: ['market', 'movers', window, scope],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/market/movers', {
        params: { query: { window, scope } },
      });
      if (error) throw error;
      return data;
    },
  });

  const activityColumns: ColumnDef<ActivityRow, unknown>[] = [
    { id: 'card', header: 'Card', cell: (c) => cardLabel(c.row.original) },
    {
      id: 'attempts',
      header: 'Attempts',
      cell: (c) => (
        <span>
          {c.row.original.attempts.toLocaleString()}
          <span className="ml-2 text-xs text-(--sl-fg-muted)">
            {c.row.original.successRate == null
              ? ''
              : `${Math.round(c.row.original.successRate * 100)}% hit`}
          </span>
        </span>
      ),
    },
    {
      id: 'median',
      header: 'Median listed',
      cell: (c) => coins(c.row.original.medianListedPrice),
    },
    {
      id: 'range',
      header: 'Range',
      cell: (c) =>
        c.row.original.minListedPrice == null
          ? '—'
          : `${coins(c.row.original.minListedPrice)} – ${coins(c.row.original.maxListedPrice)}`,
    },
    { id: 'lastSeen', header: 'Last seen', cell: (c) => formatDate(c.row.original.lastSeenAt) },
  ];

  const moverColumns: ColumnDef<MoverRow, unknown>[] = [
    { id: 'card', header: 'Card', cell: (c) => cardLabel(c.row.original) },
    {
      id: 'change',
      header: 'Change',
      cell: (c) => {
        const pct = c.row.original.changePct;
        return (
          <Badge tone={pct >= 0 ? 'positive' : 'negative'}>
            {pct >= 0 ? '+' : ''}
            {pct.toFixed(1)}%
          </Badge>
        );
      },
    },
    { id: 'from', header: 'Was', cell: (c) => coins(c.row.original.previousMedian) },
    { id: 'to', header: 'Now', cell: (c) => coins(c.row.original.currentMedian) },
    {
      id: 'samples',
      header: 'Samples',
      // Shown because a move off two observations is a very different claim
      // from one off two hundred, and the number is the only way to tell.
      cell: (c) => `${c.row.original.previousSamples} → ${c.row.original.currentSamples}`,
    },
  ];

  const activityRows = activityQuery.data?.rows ?? [];
  const moverRows = moversQuery.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={window}
          onValueChange={(v) => setWindow(v as MarketWindow)}
          options={WINDOWS}
          aria-label="Time window"
          className="w-48"
        />
        <Select
          value={scope}
          onValueChange={(v) => setScope(v as MarketScope)}
          options={SCOPES}
          aria-label="Scope"
          className="w-48"
        />
        {scope === 'market' && activityQuery.data?.meta.contributors != null && (
          <Badge tone="neutral">
            {activityQuery.data.meta.contributors} contributor
            {activityQuery.data.meta.contributors === 1 ? '' : 's'}
          </Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void activityQuery.refetch();
            void moversQuery.refetch();
          }}
        >
          Refresh
        </Button>
      </div>

      <EventsTimeline />

      <Card>
        <CardContent className="pt-5">
          <h3 className="mb-3 text-sm font-medium">Biggest movers</h3>
          {!moversQuery.isLoading && moverRows.length === 0 ? (
            <EmptyWithReason meta={moversQuery.data?.meta} kind="price moves" />
          ) : (
            <DataTable
              columns={moverColumns}
              data={moverRows}
              isLoading={moversQuery.isLoading}
              isError={moversQuery.isError}
              errorMessage="Couldn't load market movers."
              onRetry={() => void moversQuery.refetch()}
              emptyTitle="No price moves"
              getRowId={(row) => row.resourceId}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <h3 className="mb-3 text-sm font-medium">Most traded</h3>
          {!activityQuery.isLoading && activityRows.length === 0 ? (
            <EmptyWithReason meta={activityQuery.data?.meta} kind="activity" />
          ) : (
            <DataTable
              columns={activityColumns}
              data={activityRows}
              isLoading={activityQuery.isLoading}
              isError={activityQuery.isError}
              errorMessage="Couldn't load market activity."
              onRetry={() => void activityQuery.refetch()}
              emptyTitle="No activity"
              getRowId={(row) => row.resourceId}
            />
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-(--sl-fg-muted)">
        Figures are observed listing prices recorded while searching — not predictions, and not a
        complete view of the market. Medians are used throughout, so one mispriced listing does not
        drag a number with it.
      </p>
    </div>
  );
}
