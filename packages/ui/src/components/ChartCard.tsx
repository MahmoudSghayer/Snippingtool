import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './Card.js';
import { EmptyState } from './EmptyState.js';
import { Skeleton } from './Skeleton.js';

import type { ReactNode } from 'react';

export interface ChartCardProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Series legend (`ChartLegend`) — pass for any chart with >= 2 series;
   * omit for a single series (dataviz skill: no legend box for one). */
  legend?: ReactNode;
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyMessage?: string;
  height?: number;
  className?: string;
  children: ReactNode;
}

/** Frame every Recharts wrapper renders inside — title, optional
 * range/granularity controls in `actions`, an optional series `legend`, and
 * consistent loading/empty states so no chart-owning page has to hand-roll
 * them. */
export function ChartCard({ title, description, actions, legend, isLoading, isEmpty, emptyMessage = 'No data for this range.', height = 280, className, children }: ChartCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      {legend && !isLoading && !isEmpty && <div className="px-5 pb-1">{legend}</div>}
      <CardContent>
        <div style={{ height }}>
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : isEmpty ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState title={emptyMessage} />
            </div>
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}
