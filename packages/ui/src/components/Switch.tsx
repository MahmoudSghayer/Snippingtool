import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '../lib/cn.js';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

export function Switch({ className, ...props }: SwitchProps & { className?: string }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border border-[--sl-border] bg-[--sl-card-2] transition-colors',
        'data-[state=checked]:bg-[--sl-accent] data-[state=checked]:border-[--sl-accent]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--sl-accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--sl-bg]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-4 translate-x-1 rounded-full bg-[--sl-ink] transition-transform duration-[--sl-motion-fast]',
          'data-[state=checked]:translate-x-6 data-[state=checked]:bg-[--sl-accent-ink]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
