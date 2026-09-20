import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ReactNode } from 'react';

export interface CommandPaletteItem {
  key: string;
  label: string;
  sub?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  /** Screen-reader-only description of what this palette searches. */
  description?: string;
  items: CommandPaletteItem[];
  /** Shown in the empty list state — e.g. "Searching…" while a debounced
   * lookup is in flight, else "No matches." */
  emptyMessage?: string;
}

/** A Cmd/Ctrl+K command palette: type-ahead over an arbitrary `items` list
 * (routes, records, actions — the caller decides), full keyboard nav
 * (Up/Down/Enter, Esc via Radix), focus-trapped and screen-reader labelled.
 * Purely presentational — the caller owns filtering/fetching and what
 * `onSelect` does (navigate, run a command, …). Register the Cmd/Ctrl+K
 * shortcut yourself (a two-line `keydown` listener); it isn't baked in here
 * so a host app can scope it to when its own shell is mounted. */
export function CommandPalette({ open, onOpenChange, query, onQueryChange, placeholder = 'Search…', description, items, emptyMessage = 'No matches.' }: CommandPaletteProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) onQueryChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length]);

  function activate(index: number) {
    const item = items[index];
    if (!item) return;
    item.onSelect();
    onOpenChange(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(activeIndex);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className={
            'fixed left-1/2 top-[15vh] z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-[--sl-radius-lg] border border-[--sl-border] bg-[--sl-surface] shadow-2xl ' +
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'
          }
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>}
          <div className="flex items-center gap-2 border-b border-[--sl-border] px-4 py-3">
            <Search className="size-4 shrink-0 text-[--sl-fg-muted]" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-transparent text-sm text-[--sl-fg] outline-none placeholder:text-[--sl-fg-muted]"
              aria-label={placeholder}
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-activedescendant={items[activeIndex] ? `cmdk-${items[activeIndex].key}` : undefined}
            />
            <kbd className="hidden shrink-0 rounded border border-[--sl-border] px-1.5 py-0.5 font-mono text-[10px] text-[--sl-fg-muted] sm:inline">
              Esc
            </kbd>
          </div>
          <div id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[--sl-fg-muted]">{emptyMessage}</p>
            ) : (
              items.map((item, i) => (
                <button
                  key={item.key}
                  id={`cmdk-${item.key}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => activate(i)}
                  className={
                    'flex w-full items-center gap-2.5 rounded-[--sl-radius-sm] px-3 py-2 text-left text-sm transition-colors ' +
                    (i === activeIndex ? 'bg-[--sl-accent]/15 text-[--sl-accent]' : 'text-[--sl-fg] hover:bg-[--sl-card-2]')
                  }
                >
                  {item.icon && <span className={i === activeIndex ? 'text-[--sl-accent]' : 'text-[--sl-fg-muted]'}>{item.icon}</span>}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.sub && <span className="shrink-0 text-xs text-[--sl-fg-muted]">{item.sub}</span>}
                </button>
              ))
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
