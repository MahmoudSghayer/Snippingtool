import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { BotPerformancePage } from '@/pages/admin/BotPerformancePage.js';
import { useAuthStore } from '@/stores/auth.js';

import type { AdminBotPerformanceResponse, UserDto } from '@sl/shared';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE = '/api/v1/admin/bot-performance';

const none = { p50: null, p90: null };

const REPORT: AdminBotPerformanceResponse = {
  from: '2026-10-17T10:00:00.000Z',
  to: '2026-10-18T10:00:00.000Z',
  userId: ADMIN_ID,
  summary: {
    attempts: 7,
    won: 2,
    lost: 2,
    blocked: 1,
    errors: 1,
    unknown: 1,
    winRate: 0.5,
    searches: 27,
    searchesWithResults: 6,
    failedSearches: 1,
    searchesPerMinute: 5.4,
    runningMs: 300_000,
  },
  timings: {
    overall: {
      attempts: 6,
      search: { p50: 300, p90: 620 },
      reaction: { p50: 40, p90: 72 },
      buy: { p50: 600, p90: 860 },
    },
    won: {
      attempts: 2,
      search: { p50: 200, p90: 280 },
      reaction: { p50: 30, p90: 38 },
      buy: { p50: 300, p90: 380 },
    },
    lost: {
      attempts: 2,
      search: { p50: 600, p90: 680 },
      reaction: { p50: 70, p90: 78 },
      buy: { p50: 700, p90: 780 },
    },
  },
  timeSplit: { delay: 0.54, backoff: 0.02, limit: 0.04, break: 0.06, cooldown: 0.06, other: 0.28 },
  hourly: [
    {
      hour: '2026-10-18T08:00:00.000Z',
      searches: 0,
      searchesPerMinute: null,
      attempts: 0,
      won: 0,
      lost: 0,
      searchP50: null,
      reactionP50: null,
      buyP50: null,
    },
    {
      hour: '2026-10-18T09:00:00.000Z',
      searches: 24,
      searchesPerMinute: 6,
      attempts: 4,
      won: 2,
      lost: 1,
      searchP50: 310,
      reactionP50: 41,
      buyP50: 401,
    },
    {
      hour: '2026-10-18T10:00:00.000Z',
      searches: 3,
      searchesPerMinute: 3,
      attempts: 3,
      won: 0,
      lost: 1,
      searchP50: 450,
      reactionP50: 55,
      buyP50: 850,
    },
  ],
};

const EMPTY: AdminBotPerformanceResponse = {
  ...REPORT,
  summary: {
    attempts: 0,
    won: 0,
    lost: 0,
    blocked: 0,
    errors: 0,
    unknown: 0,
    winRate: null,
    searches: 0,
    searchesWithResults: 0,
    failedSearches: 0,
    searchesPerMinute: null,
    runningMs: 0,
  },
  timings: {
    overall: { attempts: 0, search: none, reaction: none, buy: none },
    won: { attempts: 0, search: none, reaction: none, buy: none },
    lost: { attempts: 0, search: none, reaction: none, buy: none },
  },
  timeSplit: null,
  hourly: [],
};

function signInAdmin() {
  const user: UserDto = {
    id: ADMIN_ID,
    email: 'owner@example.com',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    role: 'admin',
    totpEnabled: true,
    timezone: 'UTC',
    timezoneSetAt: null,
    referralCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    adminRole: 'super_admin',
    permissions: ['analytics.read'],
  };
  useAuthStore.getState().setSession(user);
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) } as never;
}

function failed(status: number) {
  return {
    data: undefined,
    error: { code: 'INTERNAL', message: 'boom' },
    response: new Response(null, { status }),
  } as never;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BotPerformancePage />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** The StatTile card whose label is `label` (a table header may share the
 * words, so match the tile's own label paragraph). */
function tile(label: string): HTMLElement {
  const labelEl = screen.getAllByText(label).find((el) => el.tagName === 'P');
  if (!labelEl) throw new Error(`no stat tile labelled ${label}`);
  return labelEl.parentElement!.parentElement!;
}

function lastQuery(get: ReturnType<typeof vi.spyOn>): Record<string, string> {
  const call = get.mock.calls.at(-1) as [string, { params: { query: Record<string, string> } }];
  expect(call[0]).toBe(ROUTE);
  return call[1].params.query;
}

let get: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  signInAdmin();
  get = vi.spyOn(api, 'GET').mockResolvedValue(ok(REPORT));
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

describe('admin BotPerformancePage', () => {
  it("shows the signed-in admin's own bot over the last 24 hours by default", async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Bot performance' })).toBeInTheDocument();
    await waitFor(() => expect(within(tile('Win rate')).getByText('50%')).toBeInTheDocument());
    expect(lastQuery(get)).toEqual({ userId: ADMIN_ID });

    expect(within(tile('Searches/min')).getByText('5.4')).toBeInTheDocument();
    expect(within(tile('Search time (p50)')).getByText('300 ms')).toBeInTheDocument();
    expect(within(tile('Reaction time (p50)')).getByText('40 ms')).toBeInTheDocument();
    expect(within(tile('Buy round trip (p50)')).getByText('600 ms')).toBeInTheDocument();
    expect(within(tile('Lost races')).getByText('2')).toBeInTheDocument();
    expect(
      screen.getByText('How long EA takes to answer a search that found the listing.'),
    ).toBeInTheDocument();
    expect(screen.getByText("Someone else's buy landed first.")).toBeInTheDocument();
  });

  it('compares won and lost races and shows where the time goes', async () => {
    renderPage();

    await screen.findByText('680 ms');
    // The page's first table is "Won vs lost"; the hourly table comes last.
    const table = screen.getAllByRole('table')[0]!;
    const searchRow = within(table).getByText('Search time').closest('tr')!;
    expect(within(searchRow).getByText('200 ms')).toBeInTheDocument();
    expect(within(searchRow).getByText('280 ms')).toBeInTheDocument();
    expect(within(searchRow).getByText('600 ms')).toBeInTheDocument();
    expect(within(searchRow).getByText('680 ms')).toBeInTheDocument();
    const buyRow = within(table).getByText('Buy round trip').closest('tr')!;
    expect(within(buyRow).getByText('780 ms')).toBeInTheDocument();
    expect(screen.getByText('Based on 2 won and 2 lost races.')).toBeInTheDocument();

    const split = screen.getByRole('list', { name: 'Where the time goes' });
    const delay = within(split).getByText('Search delay').closest('li')!;
    expect(within(delay).getByText('54%')).toBeInTheDocument();
    const other = within(split).getByText('Searching and buying').closest('li')!;
    expect(within(other).getByText('28%')).toBeInTheDocument();
  });

  it('lists only the hours with bot activity in the hourly table, newest first', async () => {
    renderPage();

    await screen.findByText('850 ms');
    const rows = screen.getAllByRole('table').at(-1)!.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('850 ms')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('401 ms')).toBeInTheDocument();
  });

  it('switches to every user, one user by ID, and a day range', async () => {
    const user = renderPage();
    await screen.findByText('680 ms');

    await user.click(screen.getByRole('button', { name: 'All users' }));
    await waitFor(() => expect(lastQuery(get)).toEqual({}));

    await user.click(screen.getByRole('button', { name: 'One user' }));
    const calls = get.mock.calls.length;
    await user.type(screen.getByLabelText('User ID'), 'not-an-id');
    expect(get.mock.calls.length).toBe(calls);
    await user.clear(screen.getByLabelText('User ID'));
    await user.type(screen.getByLabelText('User ID'), OTHER_ID);
    await waitFor(() => expect(lastQuery(get)).toEqual({ userId: OTHER_ID }));

    await user.click(screen.getByRole('button', { name: 'Me' }));
    await user.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => {
      const query = lastQuery(get);
      expect(query.userId).toBe(ADMIN_ID);
      expect(query.from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      expect(query.to).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/);
    });
    expect(screen.queryByRole('button', { name: '90d' })).not.toBeInTheDocument();
  });

  it('says when the range has no bot data', async () => {
    get.mockResolvedValue(ok(EMPTY));
    renderPage();

    expect(await screen.findByText('No bot data in this range')).toBeInTheDocument();
    expect(
      screen.getByText('The numbers appear once the bot runs with the latest Nova Trade update.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Win rate')).not.toBeInTheDocument();
  });

  it('offers a retry when the numbers fail to load', async () => {
    get.mockResolvedValue(failed(500));
    renderPage();

    expect(await screen.findByText("Couldn't load the bot's numbers.")).toBeInTheDocument();
    get.mockResolvedValue(ok(REPORT));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('680 ms')).toBeInTheDocument();
  });
});
