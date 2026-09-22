import { forwardRef } from 'react';

import { cn } from '../lib/cn.js';

import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-24 w-full rounded-[--sl-radius-sm] border bg-[--sl-ground] px-3 py-2 text-sm text-[--sl-fg] placeholder:text-[--sl-fg-muted]',
        'border-[--sl-border] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--sl-accent]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        invalid && 'border-[--sl-negative] focus-visible:ring-[--sl-negative]',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});
