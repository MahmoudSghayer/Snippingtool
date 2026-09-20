import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';

import { Button, EmptyState } from '@sl/ui';

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ground px-4">
      <EmptyState
        icon={<Compass className="size-8" />}
        title="Page not found"
        description="The page you're looking for doesn't exist or you don't have access to it."
        action={
          <Link to="/dashboard">
            <Button variant="outline">Back to dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}
