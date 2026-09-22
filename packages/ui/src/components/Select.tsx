import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  name?: string;
  'aria-label'?: string;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = 'Select…',
  disabled,
  invalid,
  className,
  name,
  ...aria
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-(--sl-radius-sm) border bg-(--sl-ground) px-3 text-sm text-(--sl-fg)',
          'border-(--sl-border) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent)',
          'disabled:opacity-50 disabled:cursor-not-allowed data-[placeholder]:text-(--sl-fg-muted)',
          invalid && 'border-(--sl-negative)',
          className,
        )}
        aria-invalid={invalid || undefined}
        {...aria}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-(--sl-fg-muted)" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 overflow-hidden rounded-(--sl-radius-md) border border-(--sl-border) bg-(--sl-surface-2) shadow-xl"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={cn(
                  'relative flex cursor-pointer select-none items-center rounded-(--sl-radius-sm) py-1.5 pl-7 pr-3 text-sm text-(--sl-fg) outline-none',
                  'data-[highlighted]:bg-(--sl-card-2) data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="size-3.5 text-(--sl-accent)" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SelectRaw({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
