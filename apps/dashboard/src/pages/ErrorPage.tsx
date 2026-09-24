import { Button, Card, CardContent, EmptyState } from '@sl/ui';
import { AlertOctagon } from 'lucide-react';

export function ErrorPage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : undefined;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ground px-4">
      <EmptyState
        icon={<AlertOctagon className="size-8 text-risk" />}
        title="Something went wrong"
        titleAs="h1"
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

/** The authenticated shell's content-area error boundary
 * (`appContentRoute`'s `errorComponent` in router.tsx). Renders inside
 * `AppLayout`'s `<main>` — unlike `ErrorPage` above (the root boundary,
 * which replaces the whole page) this keeps the sidebar/topbar mounted, and
 * `reset` retries the failed render in place instead of a full reload. */
export function AppContentErrorCard({ error, reset }: { error: unknown; reset: () => void }) {
  const message = error instanceof Error ? error.message : undefined;
  return (
    <Card>
      <CardContent className="pt-5">
        <EmptyState
          icon={<AlertOctagon className="size-8 text-risk" />}
          title="Something went wrong"
          titleAs="h1"
          description={message || 'An unexpected error occurred while rendering this page.'}
          action={
            <Button variant="outline" onClick={reset}>
              Try again
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
