import { forwardRef } from 'react';

import { cn } from '../lib/cn.js';

import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-[--sl-radius-sm] border bg-[--sl-ground] px-3 text-sm text-[--sl-fg] placeholder:text-[--sl-fg-muted]',
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
