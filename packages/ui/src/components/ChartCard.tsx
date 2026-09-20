import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './Card.js';
import { EmptyState } from './EmptyState.js';
import { Skeleton } from './Skeleton.js';

import type { ReactNode } from 'react';

export interface ChartCardProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyMessage?: string;
  height?: number;
  className?: string;
  children: ReactNode;
}

/** Frame every Recharts wrapper renders inside — title, optional
 * range/granularity controls in `actions`, and consistent loading/empty
 * states so no chart-owning page has to hand-roll them. */
export function ChartCard({ title, description, actions, isLoading, isEmpty, emptyMessage = 'No data for this range.', height = 280, className, children }: ChartCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
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
