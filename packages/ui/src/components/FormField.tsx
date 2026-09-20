import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface FormFieldProps {
  label: ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** Label + control + error/hint, wired for react-hook-form: pass the
 * field's error message (`formState.errors.x?.message`) as `error`. */
export function FormField({ label, htmlFor, error, hint, required, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-[--sl-fg]">
        {label}
        {required && <span className="ml-0.5 text-[--sl-negative]">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-[--sl-negative]" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-[--sl-fg-muted]">{hint}</p>
      ) : null}
    </div>
  );
}
