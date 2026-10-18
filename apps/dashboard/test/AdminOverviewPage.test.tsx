import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { OverviewPage } from '@/pages/admin/OverviewPage.js';
import { useAdminLiveStore } from '@/stores/adminLive.js';

type Retention = {
  cohortWeek: string;
  cohortSize: number;
  eligibleD7: number;
  eligibleD30: number;
  retainedD7: number;
  retainedD30: number;
  retentionD7: number | null;
  retentionD30: number | null;
};

function overview(retention: Retention[]) {
  return {
    from: '2026-09-19',
    to: '2026-10-18',
    totalUsers: 12,
    activeUsers7d: 5,
    activeUsers30d: 9,
    onlineUsers: 3,
    totalRevenueCents: 0,
    mrrCents: 0,
    arrCents: 0,
    conversion: { cohortSize: 0, converted: 0, rate: 0 },
    churn: { activeAtStart: 0, churned: 0, rate: 0 },
    retention,
    extensionInstalls: { total: 0, byBrowser: {} },
    versionDistribution: {},
  };
}

function renderWith(data: unknown) {
  vi.spyOn(api, 'GET').mockResolvedValue({
    data,
    error: undefined,
    response: new Response(null, { status: 200 }),
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <OverviewPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // LatestScriptCard reads the published userscript's version.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  useAdminLiveStore.setState({ lastTick: null });
});

describe('admin OverviewPage', () => {
  it('says there were no sign-ups when the range has no cohort', async () => {
    renderWith(overview([]));
    expect(await screen.findByText('No sign-ups in this range.')).toBeInTheDocument();
  });

  it('says retention is not measurable yet when every cohort is too young (null, not 0%)', async () => {
    renderWith(
      overview([
        {
          cohortWeek: '2026-10-12',
          cohortSize: 2,
          eligibleD7: 0,
          eligibleD30: 0,
          retainedD7: 0,
          retainedD30: 0,
          retentionD7: null,
          retentionD30: null,
        },
      ]),
    );
    expect(
      await screen.findByText(
        'Sign-ups in this range are under 7 days old: retention is not measurable yet.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the live counters from the admin.overview.tick push', async () => {
    useAdminLiveStore.getState().setTick({
      onlineUsers: 4,
      activeSnipesLastMinute: 17,
      errorsLastMinute: 2,
      generatedAt: '2026-10-18T09:00:00.000Z',
    });
    renderWith(overview([]));
    expect(await screen.findByText('17')).toBeInTheDocument();
    expect(screen.getByText('Extension errors (1m)')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});
