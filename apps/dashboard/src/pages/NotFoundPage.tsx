import { Button, EmptyState } from '@sl/ui';
import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';

import { homePathFor } from '@/routes/access.js';
import { useAuthStore } from '@/stores/auth.js';

export function NotFoundPage() {
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const admin = useAuthStore((s) => s.admin);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ground px-4">
      <EmptyState
        icon={<Compass className="size-8" />}
        title="Page not found"
        titleAs="h1"
        description="The page you're looking for doesn't exist or you don't have access to it."
        action={
          signedIn ? (
            <Link to={homePathFor(admin)}>
              <Button variant="outline">{admin ? 'Back to admin' : 'Back to My account'}</Button>
            </Link>
          ) : (
            <a href="/">
              <Button variant="outline">Back to the home page</Button>
            </a>
          )
        }
      />
    </div>
  );
}
