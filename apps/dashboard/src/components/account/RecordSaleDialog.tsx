// "Record sale" for a trade the extension logged as bought or listed but
// never saw sell. Reads the price the way traders type it (60k, 1.2m,
// 60,000, via @sl/shared's parser), previews EA's tax and the net before
// sending, and warns about a sale that loses more than half the buy price,
// which is usually a missing digit.
import { EA_TAX_RATE, computeTradeProfit, isHeavyLoss, parseSalePrice } from '@sl/shared';
import { Button, FormField, Input, Modal, cn, formatCoins } from '@sl/ui';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { apiErrorMessage } from '@/api/client.js';

import { useRecordSale } from './tradesQueries.js';

import type { TradeListItem } from '@sl/shared';

export function tradeLabel(trade: Pick<TradeListItem, 'cardName' | 'resourceId'>): string {
  return trade.cardName ?? `#${trade.resourceId}`;
}

export function signedCoins(value: number): string {
  return value > 0 ? `+${formatCoins(value)}` : formatCoins(value);
}

interface RecordSaleDialogProps {
  trade: TradeListItem | null;
  onOpenChange: (open: boolean) => void;
}

export function RecordSaleDialog({ trade, onOpenChange }: RecordSaleDialogProps) {
  return (
    <Modal
      open={trade !== null}
      onOpenChange={onOpenChange}
      title="Record sale"
      description={
        trade
          ? `${tradeLabel(trade)}${trade.rating != null ? ` ${trade.rating}` : ''}, bought for ${formatCoins(trade.buyPrice)} coins.`
          : undefined
      }
    >
      {/* Keyed by trade, so the form starts empty for each one. */}
      {trade && <RecordSaleForm key={trade.id} trade={trade} onDone={() => onOpenChange(false)} />}
    </Modal>
  );
}

function RecordSaleForm({ trade, onDone }: { trade: TradeListItem; onDone: () => void }) {
  const [input, setInput] = useState('');
  const recordSale = useRecordSale();

  const parsed = input.trim() === '' ? null : parseSalePrice(input);
  const price = parsed?.ok ? parsed.coins : null;
  // The trade's own tax rate when it has one, else EA's current rate — the
  // API applies EA_TAX_RATE itself when it records the sale.
  const taxRate = trade.eaTax > 0 ? trade.eaTax : EA_TAX_RATE;
  const preview = price !== null ? computeTradeProfit(trade.buyPrice, price, taxRate) : null;
  const heavyLoss = preview !== null && isHeavyLoss(trade.buyPrice, preview.netProfit);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (price === null) return;
    recordSale.mutate(
      { id: trade.id, sellPrice: price },
      {
        onSuccess: (saved) => {
          toast.success('Sale recorded', {
            description:
              saved.netProfit != null
                ? `Net profit ${signedCoins(saved.netProfit)} coins.`
                : undefined,
          });
          onDone();
        },
        onError: (error) =>
          toast.error("Couldn't record the sale", { description: apiErrorMessage(error) }),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <FormField
        label="Sale price"
        htmlFor="record-sale-price"
        error={parsed && !parsed.ok ? parsed.error : undefined}
        hint="Type 60k, 1.2m or 60,000."
      >
        <Input
          id="record-sale-price"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={input}
          invalid={parsed !== null && !parsed.ok}
          onChange={(e) => setInput(e.target.value)}
        />
      </FormField>

      {preview && price !== null && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-(--sl-radius-md) bg-surface-2 p-3 font-mono text-sm tabular-nums">
          <dt className="font-sans text-ink-2">Sale price</dt>
          <dd className="text-right text-ink">{formatCoins(price)}</dd>
          <dt className="font-sans text-ink-2">EA tax ({Math.round(taxRate * 100)}%)</dt>
          <dd className="text-right text-ink">{formatCoins(-preview.eaTaxCoins)}</dd>
          <dt className="font-sans text-ink-2">Bought for</dt>
          <dd className="text-right text-ink">{formatCoins(-trade.buyPrice)}</dd>
          <dt className="font-sans font-medium text-ink">Net profit</dt>
          <dd
            className={cn(
              'text-right font-semibold',
              preview.netProfit >= 0 ? 'text-live' : 'text-risk',
            )}
          >
            {signedCoins(preview.netProfit)}
          </dd>
        </dl>
      )}

      {heavyLoss && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-(--sl-radius-md) border border-risk-mid/40 bg-risk-mid/10 p-3 text-sm text-ink"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-mid" aria-hidden="true" />
          This sale loses more than half of what you paid. Check the price before recording it.
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-11 sm:min-h-0"
          disabled={price === null}
          loading={recordSale.isPending}
        >
          Record sale
        </Button>
      </div>
    </form>
  );
}
