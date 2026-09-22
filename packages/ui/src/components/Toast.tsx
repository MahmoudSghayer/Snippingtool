import { Toaster as SonnerToaster, toast } from 'sonner';

/** Mount once at the app root. Styled to match the dark gaming theme via CSS
 * variables rather than sonner's own theme prop, so it inherits the same
 * tokens.css every other component reads. */
export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group toast !bg-(--sl-surface-2) !border !border-(--sl-border) !text-(--sl-fg) !shadow-2xl !rounded-(--sl-radius-md)',
          title: '!text-(--sl-fg) !font-medium',
          description: '!text-(--sl-fg-muted)',
          actionButton: '!bg-(--sl-accent) !text-(--sl-accent-ink)',
          cancelButton: '!bg-(--sl-card-2) !text-(--sl-fg)',
          success: '!border-(--sl-positive)/40',
          error: '!border-(--sl-negative)/40',
          warning: '!border-(--sl-warning)/40',
        },
      }}
    />
  );
}

export { toast };
