import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Element for the title — defaults to a plain `<p>` (correct for the
   * common case: an inline empty/error state inside a page that already
   * has its own `<h1>`, e.g. a DataTable's empty rows or a ChartCard's
   * empty body). Pass `"h1"` when this *is* the page (404, a full-page
   * error boundary) so it gets real landmark/heading semantics for screen
   * readers instead of silently having none. */
  titleAs?: 'p' | 'h1' | 'h2';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  titleAs: TitleTag = 'p',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-14 text-center',
        className,
      )}
    >
      {icon && <div className="mb-1 text-[--sl-fg-muted]">{icon}</div>}
      <TitleTag className="text-sm font-medium text-[--sl-fg]">{title}</TitleTag>
      {description && <p className="max-w-sm text-sm text-[--sl-fg-muted]">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
