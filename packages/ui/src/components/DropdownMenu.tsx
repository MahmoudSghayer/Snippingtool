import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';

import { cn } from '../lib/cn.js';

import type { ComponentProps } from 'react';

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-[--sl-radius-md] border border-[--sl-border] bg-[--sl-surface-2] p-1 shadow-xl',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Item> & { destructive?: boolean }) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-[--sl-radius-sm] px-2.5 py-1.5 text-sm outline-none',
        destructive ? 'text-[--sl-negative]' : 'text-[--sl-fg]',
        'data-[highlighted]:bg-[--sl-card-2] data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownPrimitive.CheckboxItem>) {
  return (
    <DropdownPrimitive.CheckboxItem
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-[--sl-radius-sm] py-1.5 pl-7 pr-2.5 text-sm text-[--sl-fg] outline-none',
        'data-[highlighted]:bg-[--sl-card-2]',
        className,
      )}
      {...props}
    >
      <DropdownPrimitive.ItemIndicator className="absolute left-2 inline-flex items-center">
        <Check className="size-3.5 text-[--sl-accent]" aria-hidden="true" />
      </DropdownPrimitive.ItemIndicator>
      {children}
    </DropdownPrimitive.CheckboxItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Label>) {
  return (
    <DropdownPrimitive.Label
      className={cn('px-2.5 py-1.5 text-xs font-medium text-[--sl-fg-muted]', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Separator>) {
  return (
    <DropdownPrimitive.Separator
      className={cn('my-1 h-px bg-[--sl-border]', className)}
      {...props}
    />
  );
}
