import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Drawer,
  formatCoins,
  formatDate,
  formatDateTime,
  KpiGrid,
  PageHeader,
  StatTile,
  type ColumnDef,
} from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client.js';
import { downloadCsv } from '@/lib/csv.js';

import type { GalleryCompletion, GalleryUsageRow } from '@sl/shared';

/** Whole-number count (Sets, tokens, cards) — thousands-separated. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Elapsed time between two instants, or null when either is missing or the
 * span is not positive (e.g. a single completion, where first === last). */
function spanMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A coarse, readable duration: `3d 5h`, `5h 12m`, `12m`, `<1m`, or `—`. */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const days = Math.floor(totalMin / 1_440);
  const hours = Math.floor((totalMin % 1_440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function dateOrDash(value: string | null): string {
  return value ? formatDate(value) : '—';
}

const usageColumns: ColumnDef<GalleryUsageRow, unknown>[] = [
  { accessorKey: 'email', header: 'User' },
  {
    accessorKey: 'setsCompleted',
    header: 'Sets done',
    cell: (c) => <span className="tabular-nums">{formatCount(c.getValue() as number)}</span>,
  },
  {
    accessorKey: 'tokensEarned',
    header: 'Tokens',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatCount(c.getValue() as number)}</span>
    ),
  },
  {
    accessorKey: 'coinsSpent',
    header: 'Coins spent',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatCoins(c.getValue() as number)}</span>
    ),
  },
  {
    accessorKey: 'cardsCollected',
    header: 'Cards',
    cell: (c) => <span className="tabular-nums">{formatCount(c.getValue() as number)}</span>,
  },
  {
    id: 'timeTaken',
    header: 'Time taken',
    accessorFn: (row) => spanMs(row.firstCompletedAt, row.lastCompletedAt) ?? 0,
    cell: (c) =>
      formatDuration(spanMs(c.row.original.firstCompletedAt, c.row.original.lastCompletedAt)),
  },
  {
    accessorKey: 'lastCompletedAt',
    header: 'Last completed',
    cell: (c) => dateOrDash(c.getValue() as string | null),
  },
];

const completionColumns: ColumnDef<GalleryCompletion, unknown>[] = [
  { accessorKey: 'name', header: 'Set' },
  {
    accessorKey: 'grade',
    header: 'Grade',
    cell: (c) => {
      const grade = c.getValue() as string | null;
      return grade ? <Badge tone="accent">{grade}</Badge> : <span className="text-ink-2">—</span>;
    },
  },
  {
    accessorKey: 'tokens',
    header: 'Tokens',
    cell: (c) => {
      const tokens = c.getValue() as number | null;
      return (
        <span className="font-mono tabular-nums">
          {tokens === null ? '—' : formatCount(tokens)}
        </span>
      );
    },
  },
  {
    accessorKey: 'completedAt',
    header: 'Completed',
    cell: (c) => formatDateTime(c.getValue() as string),
  },
];

/** `/admin/gallery` — FUT Gallery usage per user: Sets completed, Gallery
 * Tokens earned and coins spent, cards collected, and how long it took. Click
 * a row for that user's full completed-Set log and both time spans. */
export function GalleryPage() {
  const [selected, setSelected] = useState<GalleryUsageRow | null>(null);

  const usageQuery = useQuery({
    queryKey: ['admin', 'analytics', 'gallery'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/analytics/gallery');
      if (error) throw error;
      return data;
    },
  });

  const completionsQuery = useQuery({
    queryKey: ['admin', 'analytics', 'gallery', 'completions', selected?.userId],
    enabled: selected !== null,
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/admin/analytics/gallery/{userId}/completions',
        {
          params: { path: { userId: selected!.userId }, query: { limit: 200, undone: 'exclude' } },
        },
      );
      if (error) throw error;
      return data;
    },
  });

  const items = usageQuery.data?.items ?? [];
  const totals = usageQuery.data?.totals;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Gallery"
        description="FUT Gallery usage per user — Sets completed, Gallery Tokens earned, coins spent, cards collected, and how long it took. Coins spent is the user's current list (it resets when the list is replaced)."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={items.length === 0}
            onClick={() => downloadCsv('gallery-usage.csv', items)}
          >
            Export CSV
          </Button>
        }
      />

      <KpiGrid>
        <StatTile label="Users" value={totals ? formatCount(totals.users) : '—'} />
        <StatTile label="Sets completed" value={totals ? formatCount(totals.setsCompleted) : '—'} />
        <StatTile label="Gallery Tokens" value={totals ? formatCount(totals.tokensEarned) : '—'} />
        <StatTile label="Coins spent" value={totals ? formatCoins(totals.coinsSpent) : '—'} />
        <StatTile
          label="Cards collected"
          value={totals ? formatCount(totals.cardsCollected) : '—'}
        />
      </KpiGrid>

      <Card>
        <CardHeader>
          <CardTitle>Per-user Gallery log</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={usageColumns}
            data={items}
            isLoading={usageQuery.isLoading}
            isError={usageQuery.isError}
            onRetry={() => void usageQuery.refetch()}
            emptyTitle="No Gallery activity yet"
            emptyDescription="No user has completed a Set or collected a card in Gallery mode."
            onRowClick={(row) => setSelected(row)}
            getRowId={(row) => row.userId}
          />
        </CardContent>
      </Card>

      <Drawer
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected ? `Gallery — ${selected.email}` : 'Gallery'}
        side="right"
        width="xl"
      >
        {selected && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Sets completed" value={formatCount(selected.setsCompleted)} />
              <StatTile label="Gallery Tokens" value={formatCount(selected.tokensEarned)} />
              <StatTile
                label="Coins spent (current list)"
                value={formatCoins(selected.coinsSpent)}
              />
              <StatTile label="Cards collected" value={formatCount(selected.cardsCollected)} />
            </div>

            <div className="rounded-(--sl-radius-md) border border-line">
              <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink">
                Timeline
              </div>
              <dl className="divide-y divide-line text-sm">
                <TimelineRow
                  label="First card collected"
                  value={dateOrDash(selected.firstCardAt)}
                />
                <TimelineRow
                  label="First Set completed"
                  value={dateOrDash(selected.firstCompletedAt)}
                />
                <TimelineRow
                  label="Last Set completed"
                  value={dateOrDash(selected.lastCompletedAt)}
                />
                <TimelineRow
                  label="Time taken (first → last Set)"
                  value={formatDuration(
                    spanMs(selected.firstCompletedAt, selected.lastCompletedAt),
                  )}
                />
                <TimelineRow
                  label="Time taken (first card → last Set)"
                  value={formatDuration(spanMs(selected.firstCardAt, selected.lastCompletedAt))}
                />
                <TimelineRow
                  label="Current list budget"
                  value={formatCoins(selected.coinsBudget)}
                />
              </dl>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">Completed Sets</h3>
              <DataTable
                columns={completionColumns}
                data={completionsQuery.data?.items ?? []}
                isLoading={completionsQuery.isLoading}
                isError={completionsQuery.isError}
                onRetry={() => void completionsQuery.refetch()}
                emptyTitle="No completed Sets"
                emptyDescription="This user has collected cards but not finished a Set yet."
                getRowId={(row) => String(row.setId)}
              />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function TimelineRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-mono tabular-nums text-ink">{value}</dd>
    </div>
  );
}

export default GalleryPage;
