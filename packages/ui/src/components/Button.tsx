import { forwardRef } from 'react';

import { cn } from '../lib/cn.js';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-[--sl-accent] text-[--sl-accent-ink] hover:brightness-110 active:brightness-95',
  secondary: 'bg-[--sl-card-2] text-[--sl-fg] border border-[--sl-border] hover:bg-[--sl-card]',
  outline: 'bg-transparent text-[--sl-fg] border border-[--sl-border] hover:bg-[--sl-card-2]',
  ghost: 'bg-transparent text-[--sl-fg] hover:bg-[--sl-card-2]',
  destructive: 'bg-[--sl-negative] text-[#2a0f0a] hover:brightness-110 active:brightness-95',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-[--sl-radius-sm]',
  md: 'h-10 px-4 text-sm gap-2 rounded-[--sl-radius-md]',
  lg: 'h-12 px-6 text-base gap-2 rounded-[--sl-radius-md]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    leftIcon,
    rightIcon,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-[filter,background-color,border-color] duration-[--sl-motion-fast] ease-[--sl-ease]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--sl-accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--sl-bg]',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
