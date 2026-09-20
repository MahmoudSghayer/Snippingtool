import { cn } from '../lib/cn.js';

import type { HTMLAttributes } from 'react';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('animate-pulse rounded-[--sl-radius-sm] bg-[--sl-card-2]', className)}
      {...props}
    />
  );
}
