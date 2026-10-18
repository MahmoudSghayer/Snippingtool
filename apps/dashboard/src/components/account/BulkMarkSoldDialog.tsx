// "Mark N as sold": several bought trades of one card, sold at one price
// (`POST /trades/mark-sold`). The price starts at the trader's average sale
// price for the card (`GET /trades/sell-price`) when they have sold it
// before, else empty; the time at now. Previews the tax and net over every
// selected trade, and warns when any of them loses more than half its buy
// price. The API leaves alone (and names) any trade no longer `bought`.
import { EA_TAX_RATE, computeTradeProfit, isHeavyLoss, parseSalePrice } from '@sl/shared';
import { Button, FormField, Input, Modal, cn, formatCoins } from '@sl/ui';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiErrorMessage } from '@/api/client.js';

import { SaleTimeField, signedCoins, tradeLabel, useSaleTime } from './RecordSaleDialog.js';
import { useAverageSellPrice, useMarkTradesSold } from './tradesQueries.js';

import type { TradeListItem } from '@sl/shared';

interface BulkMarkSoldDialogProps {
  /** The selected trades: all `bought`, all one card. */
  trades: TradeListItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the API answered: the selection is spent. */
  onMarked: () => void;
}

export function BulkMarkSoldDialog({
  trades,
  open,
  onOpenChange,
  onMarked,
}: BulkMarkSoldDialogProps) {
  const first = trades[0];
  const spent = trades.reduce((sum, t) => sum + t.buyPrice, 0);
  return (
    <Modal
      open={open && first !== undefined}
      onOpenChange={onOpenChange}
      title={`Mark ${trades.length} as sold`}
      description={
        first
          ? `${trades.length} × ${tradeLabel(first)}${first.rating != null ? ` ${first.rating}` : ''}, bought for ${formatCoins(spent)} coins in all.`
          : undefined
      }
    >
      {open && first && (
        <BulkMarkSoldForm trades={trades} onDone={() => onOpenChange(false)} onMarked={onMarked} />
      )}
    </Modal>
  );
}

function BulkMarkSoldForm({
  trades,
  onDone,
  onMarked,
}: {
  trades: TradeListItem[];
  onDone: () => void;
  onMarked: () => void;
}) {
  const average = useAverageSellPrice(trades[0]!.resourceId);
  const averagePrice = average.data?.averageSellPrice ?? null;
  const [input, setInput] = useState('');
  const [typed, setTyped] = useState(false);
  const saleTime = useSaleTime(trades.map((t) => t.boughtAt));
  const markSold = useMarkTradesSold();

  // The trader's average, once known, unless they already typed a price.
  useEffect(() => {
    if (!typed && averagePrice !== null) setInput(formatCoins(averagePrice));
  }, [averagePrice, typed]);

  const parsed = input.trim() === '' ? null : parseSalePrice(input);
  const price = parsed?.ok ? parsed.coins : null;
  const spent = trades.reduce((sum, t) => sum + t.buyPrice, 0);
  const profits = price !== null ? trades.map((t) => computeTradeProfit(t.buyPrice, price)) : null;
  const tax = profits?.reduce((sum, p) => sum + p.eaTaxCoins, 0) ?? 0;
  const net = profits?.reduce((sum, p) => sum + p.netProfit, 0) ?? 0;
  const heavyLoss =
    profits !== null && profits.some((p, i) => isHeavyLoss(trades[i]!.buyPrice, p.netProfit));

  const hint = average.isLoading
    ? 'Looking up your average sale price for this card.'
    : averagePrice !== null
      ? `Your average over your last ${average.data!.sales} recorded ${average.data!.sales === 1 ? 'sale' : 'sales'} of this card. Type 60k, 1.2m or 60,000.`
      : 'No recorded sales of this card yet. Type 60k, 1.2m or 60,000.';

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (price === null || saleTime.error) return;
    markSold.mutate(
      {
        ids: trades.map((t) => t.id),
        sellPrice: price,
        ...(saleTime.soldAt ? { soldAt: saleTime.soldAt } : {}),
      },
      {
        onSuccess: (result) => {
          const marked = result.updated.length;
          const skipped = result.skipped.length;
          const markedNet = result.updated.reduce((sum, t) => sum + (t.netProfit ?? 0), 0);
          toast.success(`Marked ${marked} ${marked === 1 ? 'trade' : 'trades'} as sold`, {
            description:
              skipped > 0
                ? `${skipped} left as ${skipped === 1 ? 'it was' : 'they were'}: no longer bought (sold or changed meanwhile).`
                : `Net profit ${signedCoins(markedNet)} coins.`,
          });
          onMarked();
          onDone();
        },
        onError: (error) =>
          toast.error("Couldn't mark them as sold", { description: apiErrorMessage(error) }),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <FormField
        label="Sale price, each"
        htmlFor="bulk-sale-price"
        error={parsed && !parsed.ok ? parsed.error : undefined}
        hint={hint}
      >
        <Input
          id="bulk-sale-price"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={input}
          invalid={parsed !== null && !parsed.ok}
          onChange={(e) => {
            setTyped(true);
            setInput(e.target.value);
          }}
        />
      </FormField>

      <SaleTimeField id="bulk-sale-time" field={saleTime} />

      {price !== null && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-(--sl-radius-md) bg-surface-2 p-3 font-mono text-sm tabular-nums">
          <dt className="font-sans text-ink-2">Sales ({trades.length})</dt>
          <dd className="text-right text-ink">{formatCoins(price * trades.length)}</dd>
          <dt className="font-sans text-ink-2">EA tax ({Math.round(EA_TAX_RATE * 100)}%)</dt>
          <dd className="text-right text-ink">{formatCoins(-tax)}</dd>
          <dt className="font-sans text-ink-2">Bought for</dt>
          <dd className="text-right text-ink">{formatCoins(-spent)}</dd>
          <dt className="font-sans font-medium text-ink">Net profit</dt>
          <dd className={cn('text-right font-semibold', net >= 0 ? 'text-live' : 'text-risk')}>
            {signedCoins(net)}
          </dd>
        </dl>
      )}

      {heavyLoss && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-(--sl-radius-md) border border-risk-mid/40 bg-risk-mid/10 p-3 text-sm text-ink"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-mid" aria-hidden="true" />
          At this price a sale loses more than half of what you paid. Check the price before
          recording it.
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-11 sm:min-h-0"
          disabled={price === null || saleTime.error !== undefined}
          loading={markSold.isPending}
        >
          Mark {trades.length} as sold
        </Button>
      </div>
    </form>
  );
}
