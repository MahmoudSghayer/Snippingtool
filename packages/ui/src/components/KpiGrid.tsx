import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export function KpiGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
  );
}
