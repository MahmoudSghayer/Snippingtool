import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { cn } from '../lib/cn.js';
import { formatSignedPercent } from '../lib/format.js';

import { Card } from './Card.js';

import type { ReactNode } from 'react';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  delta?: number;
  deltaLabel?: string;
  /** Positive delta reads as bad (e.g. error rate, churn) — flips the colour
   * without flipping the arrow direction, since the arrow still describes
   * the raw trend. */
  invertDeltaTone?: boolean;
  sparkline?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function StatTile({
  label,
  value,
  delta,
  deltaLabel,
  invertDeltaTone,
  sparkline,
  icon,
  className,
}: StatTileProps) {
  const isPositive = typeof delta === 'number' ? delta >= 0 : undefined;
  const tone =
    isPositive === undefined
      ? undefined
      : isPositive !== !!invertDeltaTone
        ? 'positive'
        : 'negative';

  return (
    <Card className={cn('p-5', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-(--sl-fg-muted)">{label}</p>
        {icon && <div className="text-(--sl-fg-muted)">{icon}</div>}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-(--sl-fg)">
        {value}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        {typeof delta === 'number' ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
              tone === 'positive' && 'text-(--sl-positive)',
              tone === 'negative' && 'text-(--sl-negative)',
            )}
          >
            {isPositive ? (
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            ) : (
              <ArrowDownRight className="size-3.5" aria-hidden="true" />
            )}
            {formatSignedPercent(delta)}
            {deltaLabel && <span className="text-(--sl-fg-muted)"> {deltaLabel}</span>}
          </span>
        ) : (
          <span />
        )}
        {sparkline && <div className="h-8 w-20">{sparkline}</div>}
      </div>
    </Card>
  );
}
