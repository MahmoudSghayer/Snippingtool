// "Mark as sold" for a trade the extension logged as bought or listed but
// never saw sell (sold from another device, or cleared from the transfer
// list before the extension looked). Reads the price the way traders type
// it (60k, 1.2m, 60,000, via @sl/shared's parser), takes when it sold (now,
// unless changed), previews EA's tax and the net before sending, and warns
// about a sale that loses more than half the buy price, which is usually a
// missing digit. The price and time fields are shared with the bulk dialog
// (BulkMarkSoldDialog.tsx).
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

/** `YYYY-MM-DDTHH:mm` in the browser's zone, what a datetime-local input
 * holds. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A clock a minute ahead of the API's is not a sale in the future. */
const FUTURE_SLACK_MS = 60_000;

/** The sale time to send for the sale-time field's `value`. Untouched, none:
 * the API records the sale as made now, which can never precede the
 * purchase. A time in the minute of the latest purchase (the field has no
 * seconds) is moved to that purchase; anything earlier, or in the future,
 * is an error. */
export function resolveSoldAt(
  value: string,
  touched: boolean,
  boughtAt: string[],
  now: number = Date.now(),
): { soldAt?: string; error?: string } {
  if (!touched) return {};
  const at = new Date(value).getTime();
  if (!value || Number.isNaN(at)) return { error: 'Enter the date and time it sold.' };
  if (at > now + FUTURE_SLACK_MS) return { error: "A sale can't be in the future." };
  const latest = Math.max(...boughtAt.map((b) => Date.parse(b)).filter(Number.isFinite));
  if (Number.isFinite(latest) && at < latest) {
    if (at + 60_000 > latest) return { soldAt: new Date(latest).toISOString() };
    return {
      error:
        boughtAt.length > 1
          ? 'One of these trades was bought after that time.'
          : 'It was bought after that time.',
    };
  }
  return { soldAt: new Date(at).toISOString() };
}

/** The sale-time field: now by default, in the browser's time zone. */
export function useSaleTime(boughtAt: string[]) {
  const [value, setValue] = useState(() => toLocalInputValue(new Date()));
  const [touched, setTouched] = useState(false);
  const resolved = resolveSoldAt(value, touched, boughtAt);
  return {
    value,
    onChange: (next: string) => {
      setValue(next);
      setTouched(true);
    },
    ...resolved,
  };
}

export function SaleTimeField({
  id,
  field,
}: {
  id: string;
  field: ReturnType<typeof useSaleTime>;
}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <FormField
      label="Sold at"
      htmlFor={id}
      error={field.error}
      hint={`Now, unless you change it. Your browser's time (${zone.replace(/_/g, ' ')}).`}
    >
      <Input
        id={id}
        type="datetime-local"
        value={field.value}
        max={toLocalInputValue(new Date())}
        invalid={field.error !== undefined}
        onChange={(e) => field.onChange(e.target.value)}
      />
    </FormField>
  );
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
      title="Mark as sold"
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
  const saleTime = useSaleTime([trade.boughtAt]);
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
    if (price === null || saleTime.error) return;
    recordSale.mutate(
      { id: trade.id, sellPrice: price, ...(saleTime.soldAt ? { soldAt: saleTime.soldAt } : {}) },
      {
        onSuccess: (saved) => {
          toast.success('Marked as sold', {
            description:
              saved.netProfit != null
                ? `Net profit ${signedCoins(saved.netProfit)} coins.`
                : undefined,
          });
          onDone();
        },
        onError: (error) =>
          toast.error("Couldn't mark it as sold", { description: apiErrorMessage(error) }),
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

      <SaleTimeField id="record-sale-time" field={saleTime} />

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
          disabled={price === null || saleTime.error !== undefined}
          loading={recordSale.isPending}
        >
          Mark as sold
        </Button>
      </div>
    </form>
  );
}
