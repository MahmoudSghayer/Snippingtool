import { TooltipProvider } from '@sl/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { queryClient } from '@/lib/queryClient.js';
import { router } from '@/router.js';

import '@/styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Mounted once, here, not per-page: Radix's `Tooltip` throws if
          rendered without a `TooltipProvider` ancestor anywhere in the
          tree — found by this pass (`/dev/components` was crashing to the
          error boundary on exactly this). `delayDuration` here is the
          app-wide default every `<Tooltip>` inherits unless it sets its
          own. */}
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
      </TooltipProvider>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  </StrictMode>,
);
