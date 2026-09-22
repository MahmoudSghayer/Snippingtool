import { EA_TAX_RATE, type Trade } from '@sl/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DataTable,
  formatCoins,
  formatDateTime,
  FormField,
  Input,
  Modal,
  PageHeader,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';

const PAGE_SIZE = 25;

const statusTone: Record<Trade['status'], 'positive' | 'negative' | 'neutral' | 'warning'> = {
  bought: 'neutral',
  listed: 'warning',
  sold: 'positive',
  expired: 'negative',
  unsold: 'negative',
};

function Coins({ value, signed }: { value: number | null; signed?: boolean }) {
  if (value === null) return <span className="text-ink-2">—</span>;
  const tone = signed ? (value >= 0 ? 'text-live' : 'text-risk') : '';
  return (
    <span className={`font-mono tabular-nums ${tone}`}>
      {signed && value > 0 ? '+' : ''}
      {formatCoins(value)}
    </span>
  );
}

/** Per-row tax in coins, derived from the DTO's rate so the column matches
 * what the API stored. */
function taxCoins(t: Trade): number | null {
  return t.sellPrice === null ? null : Math.round(t.sellPrice * t.eaTax);
}

const columns: ColumnDef<Trade, unknown>[] = [
  {
    accessorKey: 'resourceId',
    header: 'Player',
    cell: (c) => (
      <span className="font-mono">
        {c.getValue() as number}
        {c.row.original.rating !== null && (
          <span className="ml-1 text-ink-2">· {c.row.original.rating}</span>
        )}
      </span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => (
      <Badge tone={statusTone[c.getValue() as Trade['status']]}>{c.getValue() as string}</Badge>
    ),
  },
  {
    accessorKey: 'buyPrice',
    header: 'Buy',
    cell: (c) => <Coins value={c.getValue() as number} />,
  },
  {
    accessorKey: 'sellPrice',
    header: 'Sell',
    cell: (c) => <Coins value={c.getValue() as number | null} />,
  },
  {
    id: 'tax',
    header: 'EA tax',
    cell: (c) => <Coins value={taxCoins(c.row.original)} />,
  },
  {
    accessorKey: 'netProfit',
    header: 'Net profit',
    cell: (c) => <Coins value={c.getValue() as number | null} signed />,
  },
  {
    accessorKey: 'boughtAt',
    header: 'Bought',
    cell: (c) => formatDateTime(c.getValue() as string),
  },
  {
    accessorKey: 'soldAt',
    header: 'Sold',
    cell: (c) => {
      const value = c.getValue() as string | null;
      return value ? formatDateTime(value) : <span className="text-ink-2">—</span>;
    },
  },
];

/** Every trade the extension has reported, newest purchase first, with the
 * tax and net the API computed for each. A card the extension logged as
 * bought can be closed here with its sale price — the extension cannot see
 * the trader's own transfer list, so this is how a bought card becomes a
 * profit (or loss) on the dashboard. */
export function TradesPage() {
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const [closing, setClosing] = useState<Trade | null>(null);
  const [sellPrice, setSellPrice] = useState('');

  const tradesQuery = useQuery({
    queryKey: ['trades', 'page', cursor ?? 'first'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/trades', {
        params: { query: { limit: PAGE_SIZE, cursor } },
      });
      if (error) throw error;
      return data;
    },
  });

  const closeMutation = useMutation({
    mutationFn: async ({ id, price }: { id: string; price: number }) => {
      const { data, error } = await api.POST('/api/v1/trades/{id}/close', {
        params: { path: { id } },
        body: { sellPrice: price },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (trade) => {
      const net = trade.netProfit ?? 0;
      toast.success(`Sale recorded: ${net >= 0 ? '+' : ''}${formatCoins(net)} net`, {
        description: `${formatCoins(trade.sellPrice ?? 0)} sale, ${formatCoins(
          taxCoins(trade) ?? 0,
        )} EA tax.`,
      });
      setClosing(null);
      setSellPrice('');
      void queryClient.invalidateQueries({ queryKey: ['trades'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (error) =>
      toast.error("Couldn't record the sale", { description: apiErrorMessage(error) }),
  });

  const parsedPrice = Number.parseInt(sellPrice, 10);
  const priceValid = Number.isInteger(parsedPrice) && parsedPrice >= 0;
  const preview =
    closing && priceValid
      ? {
          tax: Math.round(parsedPrice * EA_TAX_RATE),
          net: parsedPrice - Math.round(parsedPrice * EA_TAX_RATE) - closing.buyPrice,
        }
      : null;

  const items = tradesQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Trades"
        description="Every card your extension has logged, with the tax and net profit the ledger computed."
      />

      <Card>
        <CardContent className="pt-5">
          <DataTable
            columns={columns}
            data={items}
            isLoading={tradesQuery.isLoading}
            isError={tradesQuery.isError}
            onRetry={() => void tradesQuery.refetch()}
            emptyTitle="No trades reported yet"
            emptyDescription="Buy a card with the extension running and it will show up here."
            getRowId={(row) => row.id}
            hasNextPage={Boolean(tradesQuery.data?.nextCursor)}
            hasPreviousPage={cursors.length > 1}
            onNextPage={() => {
              const next = tradesQuery.data?.nextCursor;
              if (next) setCursors((c) => [...c, next]);
            }}
            onPreviousPage={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}
            rowActions={(row) =>
              row.status === 'bought' || row.status === 'listed' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="whitespace-nowrap"
                  onClick={() => {
                    setClosing(row);
                    setSellPrice('');
                  }}
                >
                  Record sale
                </Button>
              ) : null
            }
          />
        </CardContent>
      </Card>

      <Modal
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
        title="Record a sale"
        description={
          closing
            ? `Player ${closing.resourceId}, bought for ${formatCoins(closing.buyPrice)}.`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              disabled={!priceValid || closeMutation.isPending}
              loading={closeMutation.isPending}
              onClick={() => {
                if (closing && priceValid)
                  closeMutation.mutate({ id: closing.id, price: parsedPrice });
              }}
            >
              Record sale
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (closing && priceValid) closeMutation.mutate({ id: closing.id, price: parsedPrice });
          }}
        >
          <FormField label="Sold for (coins)" htmlFor="sell-price">
            <Input
              id="sell-price"
              inputMode="numeric"
              autoFocus
              value={sellPrice}
              onChange={(e) => setSellPrice(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="e.g. 60000"
            />
          </FormField>
          {preview && (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-ink-2">EA tax ({Math.round(EA_TAX_RATE * 100)}%)</dt>
              <dd className="text-right">
                <Coins value={preview.tax} />
              </dd>
              <dt className="text-ink-2">Net profit</dt>
              <dd className="text-right">
                <Coins value={preview.net} signed />
              </dd>
            </dl>
          )}
        </form>
      </Modal>
    </div>
  );
}

export default TradesPage;
