import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-14 text-center', className)}>
      {icon && <div className="mb-1 text-[--sl-fg-muted]">{icon}</div>}
      <p className="text-sm font-medium text-[--sl-fg]">{title}</p>
      {description && <p className="max-w-sm text-sm text-[--sl-fg-muted]">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
