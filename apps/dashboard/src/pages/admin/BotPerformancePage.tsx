import { BOT_PERFORMANCE_MAX_RANGE_DAYS } from '@sl/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChartCard,
  DataTable,
  DateRangePicker,
  defaultDateRange,
  EmptyState,
  formatPercent,
  Input,
  KpiGrid,
  PageHeader,
  StatTile,
  type ColumnDef,
  type DateRange,
} from '@sl/ui';
import { AreaChart, ChartLegend, seriesLegendItems } from '@sl/ui/charts';
import { useQuery } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';

import { api } from '@/api/client.js';
import { useAuthStore } from '@/stores/auth.js';

import type {
  AdminBotPerformanceHour,
  AdminBotPerformanceResponse,
  BotTimingPercentiles,
} from '@sl/shared';

type Scope = 'me' | 'all' | 'user';
type RangeChoice = { kind: 'last24h' } | { kind: 'days'; range: DateRange };

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const userIdSchema = z.string().guid();

/** A day range as the API's inclusive instants (whole UTC days, as
 * `ActivityPage` does), cut to the last BOT_PERFORMANCE_MAX_RANGE_DAYS days
 * when a custom range is longer than the API takes. Null while a custom
 * range is half-typed or runs backwards. */
function toRangeQuery(range: DateRange): { from: string; to: string; clipped: boolean } | null {
  if (!DAY_RE.test(range.from) || !DAY_RE.test(range.to) || range.from > range.to) return null;
  const to = `${range.to}T23:59:59.999Z`;
  const earliest = new Date(
    Date.parse(`${range.to}T00:00:00.000Z`) - (BOT_PERFORMANCE_MAX_RANGE_DAYS - 1) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const clipped = range.from < earliest;
  return { from: `${clipped ? earliest : range.from}T00:00:00.000Z`, to, clipped };
}

const msFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const paceFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const hourFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
});

function formatMs(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${msFormat.format(value)} ms`;
}

function formatPace(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : paceFormat.format(value);
}

function formatRunning(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

interface TimingRow {
  key: string;
  label: string;
  won: BotTimingPercentiles;
  lost: BotTimingPercentiles;
}

const msCell = (c: { getValue: () => unknown }) => (
  <span className="font-mono tabular-nums">{formatMs(c.getValue() as number | null)}</span>
);

const timingColumns: ColumnDef<TimingRow, unknown>[] = [
  { accessorKey: 'label', header: 'Timing', enableSorting: false },
  { id: 'wonP50', header: 'Won p50', accessorFn: (r) => r.won.p50, cell: msCell },
  { id: 'wonP90', header: 'Won p90', accessorFn: (r) => r.won.p90, cell: msCell },
  { id: 'lostP50', header: 'Lost p50', accessorFn: (r) => r.lost.p50, cell: msCell },
  { id: 'lostP90', header: 'Lost p90', accessorFn: (r) => r.lost.p90, cell: msCell },
];

const countCell = (c: { getValue: () => unknown }) => (
  <span className="font-mono tabular-nums">{(c.getValue() as number).toLocaleString()}</span>
);

const hourlyColumns: ColumnDef<AdminBotPerformanceHour, unknown>[] = [
  {
    accessorKey: 'hour',
    header: 'Hour',
    cell: (c) => hourFormat.format(new Date(c.getValue() as string)),
  },
  { accessorKey: 'searches', header: 'Searches', cell: countCell },
  {
    accessorKey: 'searchesPerMinute',
    header: 'Searches/min',
    cell: (c) => (
      <span className="font-mono tabular-nums">{formatPace(c.getValue() as number | null)}</span>
    ),
  },
  { accessorKey: 'attempts', header: 'Buy attempts', cell: countCell },
  { accessorKey: 'won', header: 'Won', cell: countCell },
  { accessorKey: 'lost', header: 'Lost', cell: countCell },
  { accessorKey: 'searchP50', header: 'Search p50', cell: msCell },
  { accessorKey: 'reactionP50', header: 'Reaction p50', cell: msCell },
  { accessorKey: 'buyP50', header: 'Buy p50', cell: msCell },
];

const TIME_SPLIT_ROWS: {
  key: keyof NonNullable<AdminBotPerformanceResponse['timeSplit']>;
  label: string;
  hint: string;
}[] = [
  { key: 'delay', label: 'Search delay', hint: 'the wait you set between two searches' },
  { key: 'backoff', label: 'EA backoff', hint: 'slowing down after EA pushed back' },
  { key: 'limit', label: 'Limits', hint: 'held back by the hourly and safety limits' },
  { key: 'break', label: 'Breaks and rest', hint: 'short breaks and longer rests' },
  { key: 'cooldown', label: 'Pause after a buy', hint: 'the cooldown after each buy' },
  { key: 'other', label: 'Searching and buying', hint: "waiting for EA's answers and buying" },
];

const raceSeries = [
  { key: 'won', label: 'Won', colorIndex: 0 },
  { key: 'lost', label: 'Lost', colorIndex: 2 },
];

function useBotPerformance(choice: RangeChoice, userId: string | undefined, enabled: boolean) {
  const range = choice.kind === 'days' ? toRangeQuery(choice.range) : null;
  const rangeValid = choice.kind === 'last24h' || range !== null;
  const query = useQuery({
    queryKey: ['admin', 'bot-performance', choice, userId ?? 'all'],
    enabled: enabled && rangeValid,
    // "Last 24 hours" moves with the clock; a fixed day range does not.
    refetchInterval: choice.kind === 'last24h' ? 60_000 : false,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/bot-performance', {
        params: {
          query: {
            ...(range ? { from: range.from, to: range.to } : {}),
            ...(userId ? { userId } : {}),
          },
        },
      });
      if (error) throw error;
      return data;
    },
  });
  return { query, rangeValid, clipped: range?.clipped ?? false };
}

/** `/admin/performance` — the Nova AI bot's speed and race results: how
 * fast it searches, how fast it reacts to a listing, whether its buys land
 * first, and where its running time goes (`GET /admin/bot-performance`). */
export function BotPerformancePage() {
  const myUserId = useAuthStore((s) => s.user?.id ?? null);
  const [scope, setScope] = useState<Scope>('me');
  const [otherUserId, setOtherUserId] = useState('');
  const [choice, setChoice] = useState<RangeChoice>({ kind: 'last24h' });
  const [dayRange, setDayRange] = useState<DateRange>(defaultDateRange('7d'));

  const otherUserIdValid = userIdSchema.safeParse(otherUserId.trim()).success;
  const userId =
    scope === 'me' ? (myUserId ?? undefined) : scope === 'user' ? otherUserId.trim() : undefined;
  const userReady = scope === 'me' ? myUserId !== null : scope === 'user' ? otherUserIdValid : true;

  const { query, rangeValid, clipped } = useBotPerformance(choice, userId, userReady);
  const enabled = userReady && rangeValid;
  const data = query.data;
  const hasData = !!data && (data.summary.attempts > 0 || data.summary.runningMs > 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bot performance"
        description="How fast the Nova AI bot searches and reacts, whether it wins the race for listings, and where its time goes."
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Whose bot">
          {(
            [
              ['me', 'Me'],
              ['all', 'All users'],
              ['user', 'One user'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={scope === key ? 'primary' : 'outline'}
              aria-pressed={scope === key}
              onClick={() => setScope(key)}
            >
              {label}
            </Button>
          ))}
          {scope === 'user' && (
            <Input
              aria-label="User ID"
              placeholder="User ID"
              className="h-8 w-80 font-mono text-xs"
              value={otherUserId}
              invalid={otherUserId.trim() !== '' && !otherUserIdValid}
              onChange={(e) => setOtherUserId(e.target.value)}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={choice.kind === 'last24h' ? 'primary' : 'outline'}
            onClick={() => setChoice({ kind: 'last24h' })}
          >
            Last 24 h
          </Button>
          <DateRangePicker
            value={dayRange}
            presets={['7d', '30d']}
            activePreset={choice.kind === 'last24h' ? null : undefined}
            onChange={(range) => {
              setDayRange(range);
              setChoice({ kind: 'days', range });
            }}
          />
        </div>
      </div>

      {scope === 'user' && !otherUserIdValid && (
        <p className="text-sm text-ink-2">
          Paste the user&apos;s ID to see their bot: the User column on the Activity page shows it.
        </p>
      )}
      {!rangeValid && (
        <p className="text-sm text-ink-2">Pick a start date on or before the end date.</p>
      )}
      {clipped && (
        <p className="text-sm text-ink-2">
          Showing the last {BOT_PERFORMANCE_MAX_RANGE_DAYS} days of that range, the longest this
          page covers.
        </p>
      )}

      {!enabled ? null : query.isError ? (
        <Card>
          <EmptyState
            title="Couldn't load the bot's numbers."
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : data && !hasData ? (
        <Card>
          <EmptyState
            icon={<Timer className="size-6" aria-hidden="true" />}
            title="No bot data in this range"
            description="The numbers appear once the bot runs with the latest Nova Trade update."
          />
        </Card>
      ) : (
        <PerformanceReport data={data} isLoading={query.isLoading} />
      )}
    </div>
  );
}

function PerformanceReport({
  data,
  isLoading,
}: {
  data: AdminBotPerformanceResponse | undefined;
  isLoading: boolean;
}) {
  const s = data?.summary;
  const t = data?.timings;
  const hourly = data?.hourly ?? [];
  const activeHours = hourly.filter((h) => h.searches > 0 || h.attempts > 0).reverse();
  const chartData = hourly.map((h) => ({
    label: hourFormat.format(new Date(h.hour)),
    searchesPerMinute:
      h.searchesPerMinute === null ? null : Math.round(h.searchesPerMinute * 10) / 10,
    won: h.won,
    lost: h.lost,
  }));
  const timingRows: TimingRow[] = t
    ? [
        { key: 'search', label: 'Search time', won: t.won.search, lost: t.lost.search },
        { key: 'reaction', label: 'Reaction', won: t.won.reaction, lost: t.lost.reaction },
        { key: 'buy', label: 'Buy round trip', won: t.won.buy, lost: t.lost.buy },
      ]
    : [];

  return (
    <>
      <KpiGrid className="lg:grid-cols-3">
        <StatTile
          label="Win rate"
          value={s ? (s.winRate === null ? '—' : formatPercent(s.winRate)) : '—'}
          hint={
            s
              ? `Races won out of races decided: ${s.won} won, ${s.lost} lost.`
              : 'Races won out of races decided.'
          }
        />
        <StatTile
          label="Searches/min"
          value={formatPace(s?.searchesPerMinute)}
          hint={
            s && s.runningMs > 0
              ? `${s.searches.toLocaleString()} searches over ${formatRunning(s.runningMs)} of running, waits included.`
              : 'How often the bot searched while it ran, waits included.'
          }
        />
        <StatTile
          label="Search time (p50)"
          value={formatMs(t?.overall.search.p50)}
          hint="How long EA takes to answer a search that found the listing."
        />
        <StatTile
          label="Reaction time (p50)"
          value={formatMs(t?.overall.reaction.p50)}
          hint="From the listing arriving to the bot sending its buy."
        />
        <StatTile
          label="Buy round trip (p50)"
          value={formatMs(t?.overall.buy.p50)}
          hint="How long EA takes to answer the buy request."
        />
        <StatTile
          label="Lost races"
          value={s ? s.lost.toLocaleString() : '—'}
          hint="Someone else's buy landed first."
        />
      </KpiGrid>

      {s && (
        <p className="text-sm text-ink-2">
          {s.attempts.toLocaleString()} buy attempts: {s.won} won, {s.lost} lost, {s.blocked} held
          back by the bot&apos;s limits, {s.errors} EA errors, {s.unknown} with no answer in time.{' '}
          {s.searches.toLocaleString()} searches, {s.searchesWithResults.toLocaleString()} found
          listings, {s.failedSearches.toLocaleString()} failed. p50 is the typical attempt; p90 the
          slow end (9 in 10 were faster).
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Won vs lost</CardTitle>
              <CardDescription className="mt-0.5">
                Were the lost races slower? Compare each step of a won buy with a lost one.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={timingColumns}
              data={timingRows}
              isLoading={isLoading}
              emptyTitle="No timed buy attempts"
              getRowId={(row) => row.key}
            />
            {t && (
              <p className="mt-3 text-xs text-ink-2">
                Based on {t.won.attempts} won and {t.lost.attempts} lost races.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Where the time goes</CardTitle>
              <CardDescription className="mt-0.5">
                Share of the time the bot ran, from the pace it reports every 2 minutes.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data?.timeSplit ? (
              <ul className="flex flex-col gap-3" aria-label="Where the time goes">
                {TIME_SPLIT_ROWS.map((row) => {
                  const value = data.timeSplit![row.key];
                  return (
                    <li key={row.key} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-ink">
                          {row.label} <span className="text-xs text-ink-2">— {row.hint}</span>
                        </span>
                        <span className="font-mono tabular-nums text-ink">
                          {formatPercent(value)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-gold"
                          style={{ width: `${Math.round(value * 1000) / 10}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-2">
                {isLoading ? 'Loading…' : 'No pace reports in this range.'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Search pace"
          description="Searches per minute, each hour the bot ran."
          isLoading={isLoading}
          isEmpty={!isLoading && !hourly.some((h) => h.searchesPerMinute !== null)}
          emptyMessage="No pace reports in this range."
        >
          <AreaChart
            data={chartData}
            xKey="label"
            series={[{ key: 'searchesPerMinute', label: 'Searches/min', colorIndex: 3 }]}
            connectNulls={false}
          />
        </ChartCard>
        <ChartCard
          title="Races won and lost"
          description="Buy attempts won and lost, each hour."
          legend={<ChartLegend items={seriesLegendItems(raceSeries)} />}
          isLoading={isLoading}
          isEmpty={!isLoading && !hourly.some((h) => h.won > 0 || h.lost > 0)}
          emptyMessage="No races won or lost in this range."
        >
          <AreaChart data={chartData} xKey="label" series={raceSeries} />
        </ChartCard>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>By hour</CardTitle>
            <CardDescription className="mt-0.5">
              Hours with bot activity, newest first. Timings are medians over that hour&apos;s buy
              attempts.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={hourlyColumns}
            data={activeHours}
            isLoading={isLoading}
            emptyTitle="No bot activity in this range"
            getRowId={(row) => row.hour}
          />
        </CardContent>
      </Card>
    </>
  );
}

export default BotPerformancePage;
