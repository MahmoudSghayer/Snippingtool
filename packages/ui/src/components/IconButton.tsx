import { forwardRef } from 'react';

import { cn } from '../lib/cn.js';

import type { ButtonVariant } from './Button.js';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-[--sl-accent] text-[--sl-accent-ink] hover:brightness-110',
  secondary: 'bg-[--sl-card-2] text-[--sl-fg] border border-[--sl-border] hover:bg-[--sl-card]',
  outline: 'bg-transparent text-[--sl-fg] border border-[--sl-border] hover:bg-[--sl-card-2]',
  ghost: 'bg-transparent text-[--sl-fg-muted] hover:bg-[--sl-card-2] hover:text-[--sl-fg]',
  destructive: 'bg-[--sl-negative] text-[#2a0f0a] hover:brightness-110',
};

/** Icon-only control action button. `label` is mandatory (rendered as
 * `aria-label` + `title`) — this package has no icon-only button without an
 * accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon, label, variant = 'ghost', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-[--sl-radius-sm] transition-colors duration-[--sl-motion-fast]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--sl-accent]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'size-8' : 'size-10',
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});
