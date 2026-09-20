import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, breadcrumb, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3 border-b border-[--sl-border] pb-5 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-[--sl-fg-muted]">{breadcrumb}</div>}
        <h1 className="truncate text-xl font-semibold text-[--sl-fg]">{title}</h1>
        {description && <p className="mt-1 text-sm text-[--sl-fg-muted]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
