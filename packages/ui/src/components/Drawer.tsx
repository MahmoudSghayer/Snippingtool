import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg' | 'xl';
}

const widthClasses = { md: 'max-w-md', lg: 'max-w-xl', xl: 'max-w-3xl' };

/** Right-side panel for record detail views (user detail, audit entry) —
 * wider and scrollable, unlike Modal. */
export function Drawer({ open, onOpenChange, title, description, children, footer, width = 'lg' }: DrawerProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-[--sl-border] bg-[--sl-surface] shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
            widthClasses[width],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[--sl-border] px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-[--sl-fg]">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-sm text-[--sl-fg-muted]">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-[--sl-radius-sm] p-1 text-[--sl-fg-muted] hover:bg-[--sl-card-2] hover:text-[--sl-fg]"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-[--sl-border] px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
