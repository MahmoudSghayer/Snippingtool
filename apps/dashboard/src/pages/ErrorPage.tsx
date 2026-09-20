import { Button, EmptyState } from '@sl/ui';
import { AlertOctagon } from 'lucide-react';


export function ErrorPage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : undefined;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ground px-4">
      <EmptyState
        icon={<AlertOctagon className="size-8 text-risk" />}
        title="Something went wrong"
        description={message || 'An unexpected error occurred while rendering this page.'}
        action={
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
    </div>
  );
}
