import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '../lib/cn.js';

export interface CheckboxProps {
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean | 'indeterminate') => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'flex size-5 items-center justify-center rounded-[4px] border border-(--sl-border) bg-(--sl-ground)',
        'data-[state=checked]:bg-(--sl-accent) data-[state=checked]:border-(--sl-accent)',
        'data-[state=indeterminate]:bg-(--sl-accent) data-[state=indeterminate]:border-(--sl-accent)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent)',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="text-(--sl-accent-ink)">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
