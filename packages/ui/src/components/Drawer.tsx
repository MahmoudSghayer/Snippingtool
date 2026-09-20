import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for a chrome-less drawer (e.g. the mobile nav, which supplies its
   * own header) — title/description/footer stay optional together. */
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg' | 'xl' | 'nav';
  /** 'right' (default) for record-detail panels; 'left' for off-canvas
   * navigation (the mobile sidebar). */
  side?: 'left' | 'right';
}

const widthClasses = { md: 'max-w-md', lg: 'max-w-xl', xl: 'max-w-3xl', nav: 'max-w-72' };

/** Side panel for record detail views (user detail, audit entry — `side="right"`,
 * the default) and for off-canvas navigation on narrow viewports
 * (`side="left"`, e.g. the mobile sidebar) — wider and scrollable, unlike
 * Modal. */
export function Drawer({ open, onOpenChange, title, description, children, footer, width = 'lg', side = 'right' }: DrawerProps) {
  const isLeft = side === 'left';
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 z-50 flex w-full flex-col shadow-2xl',
            isLeft ? 'left-0 border-r border-[--sl-border] bg-[--sl-surface]' : 'right-0 border-l border-[--sl-border] bg-[--sl-surface]',
            isLeft
              ? 'data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left'
              : 'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
            widthClasses[width],
          )}
        >
          {title ? (
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
          ) : (
            // Visually-hidden title: Radix requires one for a11y even when
            // the content supplies its own header (the mobile nav's brand row).
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          )}
          <div className={title ? 'flex-1 overflow-y-auto px-5 py-4' : 'flex-1 overflow-y-auto'}>{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-[--sl-border] px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
