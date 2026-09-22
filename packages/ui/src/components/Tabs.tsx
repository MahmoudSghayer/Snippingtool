import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '../lib/cn.js';

import type { ComponentProps } from 'react';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-1 rounded-(--sl-radius-md) border border-(--sl-border) bg-(--sl-surface-2) p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'rounded-(--sl-radius-sm) px-3 py-1.5 text-sm font-medium text-(--sl-fg-muted) transition-colors',
        'data-[state=active]:bg-(--sl-accent) data-[state=active]:text-(--sl-accent-ink)',
        'hover:text-(--sl-fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--sl-accent)',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('mt-4 focus-visible:outline-none', className)}
      {...props}
    />
  );
}
