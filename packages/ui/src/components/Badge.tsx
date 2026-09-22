import { cn } from '../lib/cn.js';

import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'positive' | 'negative' | 'warning' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-[--sl-card-2] text-[--sl-fg-muted] border-[--sl-border]',
  positive: 'bg-[--sl-positive]/15 text-[--sl-positive] border-[--sl-positive]/30',
  negative: 'bg-[--sl-negative]/15 text-[--sl-negative] border-[--sl-negative]/30',
  warning: 'bg-[--sl-warning]/15 text-[--sl-warning] border-[--sl-warning]/30',
  accent: 'bg-[--sl-accent]/15 text-[--sl-accent] border-[--sl-accent]/30',
};

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-none',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}
