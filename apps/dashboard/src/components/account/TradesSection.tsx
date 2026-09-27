// "Your trades" on /account: today's net in the trader's own time zone,
// totals for the current filters, and the trades themselves (a table from
// `sm` up, cards below it) with a "Record sale" action on every trade not
// yet sold. Filters and order are applied by the API: the list is
// cursor-paged, so sorting on the client would only reorder one page.
//
// Renders content only; AccountPage wraps it in its AccountSection.
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Skeleton,
  cn,
  formatCoins,
  type BadgeTone,
  type ColumnDef,
} from '@sl/ui';
import { Download, Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { downloadServerCsv } from '@/lib/csv.js';
import { useAuthStore } from '@/stores/auth.js';

import { RecordSaleDialog, signedCoins, tradeLabel } from './RecordSaleDialog.js';
import { formatInZone, initialTimeZone, timeZoneOptions } from './timezone.js';
import {
  filterQuery,
  useSaveTimeZone,
  useTodayNet,
  useTradesPage,
  useTradeTotals,
  type TradeFilters,
} from './tradesQueries.js';

import type { TradeListItem, TradeStatus } from '@sl/shared';

const STATUS_OPTIONS: { value: TradeStatus; label: string }[] = [
  { value: 'bought', label: 'Bought' },
  { value: 'listed', label: 'Listed' },
  { value: 'sold', label: 'Sold' },
  { value: 'expired', label: 'Expired' },
];

const STATUS_TONE: Record<TradeStatus, BadgeTone> = {
  bought: 'accent',
  listed: 'warning',
  sold: 'positive',
  expired: 'neutral',
  unsold: 'neutral',
};

const STATUS_LABEL: Record<TradeStatus, string> = {
  bought: 'Bought',
  listed: 'Listed',
  sold: 'Sold',
  expired: 'Expired',
  unsold: 'Unsold',
};

/** A native <select>, styled like @sl/ui's Input: ~400 time zones are
 * easier to pick from the platform's own list (typeahead, and a proper
 * picker on phones) than from a custom popover. */
const SELECT_CLASSES =
  'h-11 w-full rounded-(--sl-radius-sm) border border-(--sl-border) bg-(--sl-ground) px-3 text-sm text-(--sl-fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent) sm:h-10';

const canRecordSale = (t: TradeListItem) => t.status === 'bought' || t.status === 'listed';

function CardName({ trade }: { trade: TradeListItem }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-medium text-ink">{tradeLabel(trade)}</span>
      {trade.rating != null && <span className="font-mono text-xs text-ink-2">{trade.rating}</span>}
    </span>
  );
}

function Net({ value }: { value: number | null }) {
  if (value == null) return <span className="text-ink-2">—</span>;
  return (
    <span className={cn('font-mono tabular-nums', value >= 0 ? 'text-live' : 'text-risk')}>
      {signedCoins(value)}
    </span>
  );
}

function Kpi({
  label,
  value,
  caption,
  loading,
  tone,
}: {
  label: string;
  value: string | undefined;
  caption?: string;
  loading: boolean;
  /** Green when positive, red when negative. */
  tone?: 'signed';
}) {
  return (
    <Card role="group" aria-label={label} className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-2">{label}</p>
      {loading || value === undefined ? (
        <Skeleton className="mt-2 h-6 w-24" />
      ) : (
        <p
          className={cn(
            'mt-1.5 break-all font-mono text-lg font-semibold tabular-nums text-ink sm:text-xl',
            tone === 'signed' && (value.startsWith('-') ? 'text-risk' : 'text-live'),
          )}
        >
          {value}
        </p>
      )}
      {caption && <p className="mt-1 text-xs text-ink-2">{caption}</p>}
    </Card>
  );
}

export function TradesSection() {
  const account = useAuthStore((s) => s.user);
  const [tz, setTz] = useState(() => initialTimeZone(account));
  const [filters, setFilters] = useState<TradeFilters>({});
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  // Cursors of the pages visited so far; the last one is on screen.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selling, setSelling] = useState<TradeListItem | null>(null);
  const [exporting, setExporting] = useState(false);

  const cursor = cursors.at(-1);
  const page = useTradesPage(filters, tz, order, cursor);
  const totals = useTradeTotals(filters, tz);
  const today = useTodayNet(tz);
  const saveTimeZone = useSaveTimeZone();
  const zones = useMemo(() => timeZoneOptions(tz), [tz]);

  const trades = page.data?.items ?? [];
  const filtered = Boolean(filters.status || filters.from || filters.to);

  function updateFilters(next: TradeFilters) {
    setFilters(next);
    setCursors([undefined]);
  }

  function changeTimeZone(next: string) {
    setTz(next);
    setCursors([undefined]);
    saveTimeZone.mutate(next, {
      onError: () =>
        toast.error("Couldn't save your time zone", {
          description: 'It applies on this page until you reload.',
        }),
    });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const query = new URLSearchParams(filterQuery(filters, tz));
      await downloadServerCsv('trades.csv', `/api/v1/trades/export.csv?${query.toString()}`);
    } catch {
      toast.error("Couldn't export your trades", { description: 'Please try again.' });
    } finally {
      setExporting(false);
    }
  }

  const recordSaleButton = (trade: TradeListItem, className?: string) =>
    canRecordSale(trade) && (
      <Button
        size="sm"
        variant="outline"
        // 44px touch target (WCAG 2.5.5) on every row action.
        className={cn('min-h-11', className)}
        onClick={() => setSelling(trade)}
        aria-label={`Record sale for ${tradeLabel(trade)}`}
      >
        Record sale
      </Button>
    );

  // Sorting is the server's job (see the header comment), so no column
  // offers DataTable's client-side sort.
  const columns = (
    [
      { id: 'card', header: 'Card', cell: (c) => <CardName trade={c.row.original} /> },
      {
        id: 'status',
        header: 'Status',
        cell: (c) => (
          <Badge tone={STATUS_TONE[c.row.original.status]}>
            {STATUS_LABEL[c.row.original.status]}
          </Badge>
        ),
      },
      {
        id: 'boughtAt',
        header: 'Bought',
        cell: (c) => (
          <span className="whitespace-nowrap text-ink-2">
            {formatInZone(c.row.original.boughtAt, tz)}
          </span>
        ),
      },
      {
        id: 'buyPrice',
        header: 'Buy',
        cell: (c) => (
          <span className="font-mono tabular-nums">{formatCoins(c.row.original.buyPrice)}</span>
        ),
      },
      {
        id: 'sellPrice',
        header: 'Sell',
        cell: (c) =>
          c.row.original.sellPrice != null ? (
            <span className="font-mono tabular-nums">{formatCoins(c.row.original.sellPrice)}</span>
          ) : (
            <span className="text-ink-2">—</span>
          ),
      },
      { id: 'netProfit', header: 'Net', cell: (c) => <Net value={c.row.original.netProfit} /> },
    ] satisfies ColumnDef<TradeListItem, unknown>[]
  ).map((col): ColumnDef<TradeListItem, unknown> => ({ ...col, enableSorting: false }));

  const empty = filtered ? (
    <EmptyState
      icon={<Inbox className="size-6" />}
      title="No trades match these filters"
      action={
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => updateFilters({})}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<Inbox className="size-6" />}
      title="No trades yet"
      description="Trades show up here as the extension buys cards. Install it, arm a saved search, and your first snipe lands here."
      action={
        <a
          href="#extension"
          className="inline-flex min-h-11 items-center rounded-(--sl-radius-sm) bg-(--sl-accent) px-4 text-sm font-medium text-(--sl-accent-ink) hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent)"
        >
          Get the extension
        </a>
      }
    />
  );
  const showEmpty = !page.isLoading && !page.isError && trades.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Net profit today"
          value={today.data !== undefined ? signedCoins(today.data) : undefined}
          caption={tz.replace(/_/g, ' ')}
          loading={today.isLoading}
          tone="signed"
        />
        <Kpi
          label="Spent"
          value={totals.data ? formatCoins(totals.data.spent) : undefined}
          caption={totals.data ? `${formatCoins(totals.data.count)} trades` : undefined}
          loading={totals.isLoading}
        />
        <Kpi
          label="Revenue"
          value={totals.data ? formatCoins(totals.data.revenue) : undefined}
          caption={totals.data ? `${formatCoins(totals.data.sold)} sold` : undefined}
          loading={totals.isLoading}
        />
        <Kpi
          label="Net profit"
          value={totals.data ? signedCoins(totals.data.netProfit) : undefined}
          caption={filtered ? 'For these filters' : 'All trades'}
          loading={totals.isLoading}
          tone="signed"
        />
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Status
            <select
              className={SELECT_CLASSES}
              value={filters.status ?? ''}
              onChange={(e) =>
                updateFilters({
                  ...filters,
                  status: (e.target.value || undefined) as TradeStatus | undefined,
                })
              }
            >
              <option value="">All</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Order
            <select
              className={SELECT_CLASSES}
              value={order}
              onChange={(e) => {
                setOrder(e.target.value as 'asc' | 'desc');
                setCursors([undefined]);
              }}
            >
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            From
            <input
              type="date"
              className={SELECT_CLASSES}
              value={filters.from ?? ''}
              max={filters.to}
              onChange={(e) => updateFilters({ ...filters, from: e.target.value || undefined })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            To
            <input
              type="date"
              className={SELECT_CLASSES}
              value={filters.to ?? ''}
              min={filters.from}
              onChange={(e) => updateFilters({ ...filters, to: e.target.value || undefined })}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1.5 text-sm font-medium text-ink sm:col-span-3">
            Time zone
            <select
              className={SELECT_CLASSES}
              value={tz}
              onChange={(e) => changeTimeZone(e.target.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Button
              variant="outline"
              className="min-h-11 w-full"
              leftIcon={<Download className="size-4" aria-hidden="true" />}
              loading={exporting}
              disabled={showEmpty}
              onClick={() => void exportCsv()}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      {showEmpty ? (
        <Card>{empty}</Card>
      ) : (
        <>
          <div className="hidden sm:block">
            <DataTable
              columns={columns}
              data={trades}
              isLoading={page.isLoading}
              isError={page.isError}
              onRetry={() => void page.refetch()}
              getRowId={(row) => row.id}
              rowActions={(row) => recordSaleButton(row)}
            />
          </div>

          <ul aria-label="Trades" className="flex flex-col gap-3 sm:hidden">
            {trades.map((trade) => (
              <li key={trade.id}>
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <CardName trade={trade} />
                    <Badge tone={STATUS_TONE[trade.status]}>{STATUS_LABEL[trade.status]}</Badge>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-ink-2">Buy</dt>
                      <dd className="font-mono tabular-nums">{formatCoins(trade.buyPrice)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-2">Sell</dt>
                      <dd className="font-mono tabular-nums">
                        {trade.sellPrice != null ? formatCoins(trade.sellPrice) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-2">Net</dt>
                      <dd>
                        <Net value={trade.netProfit} />
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs text-ink-2">Bought {formatInZone(trade.boughtAt, tz)}</p>
                  {recordSaleButton(trade, 'w-full')}
                </Card>
              </li>
            ))}
          </ul>

          {(cursors.length > 1 || page.data?.nextCursor) && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={cursors.length <= 1}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={!page.data?.nextCursor || page.isFetching}
                onClick={() => {
                  const next = page.data?.nextCursor;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <RecordSaleDialog trade={selling} onOpenChange={(open) => !open && setSelling(null)} />
    </div>
  );
}
