import { STARTER_FILTERS, type DeviceDto, type SavedFilter, type UserDto } from '@sl/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { GettingStarted, GETTING_STARTED_HIDDEN_KEY } from '@/components/account/GettingStarted.js';
import { StarterFilters } from '@/components/account/StarterFilters.js';
import { useAuthStore } from '@/stores/auth.js';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const USER: UserDto = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'player@example.com',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  role: 'user',
  totpEnabled: false,
  timezone: 'UTC',
  referralCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  adminRole: null,
  permissions: [],
};

const ACTIVE_SUB = {
  id: '00000000-0000-0000-0000-0000000000b1',
  plan: {
    id: '00000000-0000-0000-0000-00000000000a',
    code: 'pro',
    name: 'Monthly',
    priceCents: 999,
    currency: 'usd',
    interval: 'month',
    deviceLimit: 2,
    features: [],
    isLifetime: false,
  },
  status: 'active',
  currentPeriodStart: '2026-09-24T12:00:00.000Z',
  currentPeriodEnd: '2099-10-24T12:00:00.000Z',
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  autoRenew: false,
};

const DEVICE: DeviceDto = {
  id: '00000000-0000-0000-0000-0000000000d1',
  name: 'Home PC',
  browser: 'Chrome',
  os: 'Windows',
  extensionVersion: '1.0.0',
  status: 'active',
  firstSeenAt: '2026-09-01T12:00:00.000Z',
  lastSeenAt: '2026-09-20T12:00:00.000Z',
  trustedAt: null,
  isCurrent: true,
};

function savedFilter(name: string, filter: SavedFilter['filter']): SavedFilter {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    name,
    filter,
    filterHash: 'x',
    isActive: true,
    sortOrder: 0,
    createdAt: '2026-09-01T12:00:00.000Z',
  };
}

const TRADE = { id: '00000000-0000-0000-0000-0000000000c1' };

/** `GET /subscriptions/me`'s resolved entitlements; the checklist only asks
 * for filters and trades when these include their features. */
const PAID_ENTITLEMENTS = { features: ['assist.filter_rotation', 'ledger.recorder'] };

type Reply = { data?: unknown; error?: unknown; status?: number };

function ok(data: unknown): Reply {
  return { data, status: 200 };
}
function fail(code: string, status: number): Reply {
  return { error: { code, message: 'nope' }, status };
}

interface Scenario {
  subscription?: Reply;
  devices?: Reply;
  filters?: Reply;
  trades?: Reply;
}

function mockApi(s: Scenario = {}) {
  const replies: Record<string, Reply> = {
    '/api/v1/subscriptions/me':
      s.subscription ?? ok({ subscription: null, license: null, entitlements: PAID_ENTITLEMENTS }),
    '/api/v1/devices': s.devices ?? ok([]),
    '/api/v1/filters': s.filters ?? ok([]),
    '/api/v1/trades': s.trades ?? ok({ items: [], nextCursor: null }),
  };
  return vi.spyOn(api, 'GET').mockImplementation(((path: string) => {
    const r = replies[path] ?? fail('NOT_FOUND', 404);
    return Promise.resolve({
      data: r.data,
      error: r.error,
      response: new Response(null, { status: r.status ?? 200 }),
    });
  }) as never);
}

function allDone(): Scenario {
  return {
    subscription: ok({ subscription: ACTIVE_SUB, license: null, entitlements: PAID_ENTITLEMENTS }),
    devices: ok([DEVICE]),
    filters: ok([savedFilter('Mine', { maxPrice: 1000 })]),
    trades: ok({ items: [TRADE], nextCursor: null }),
  };
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...utils, queryClient, user: userEvent.setup() };
}

function step(name: RegExp) {
  const region = screen.getByRole('region', { name: 'Getting started' });
  return within(region).getByRole('listitem', { name });
}

beforeEach(() => {
  useAuthStore.getState().setSession(USER);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
  localStorage.clear();
});

describe('GettingStarted', () => {
  it('shows five unticked steps for a new account, with one action each', async () => {
    useAuthStore.getState().setSession({ ...USER, emailVerifiedAt: null });
    mockApi();
    renderWithClient(<GettingStarted />);

    const region = await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(within(region).getByText('0 of 5 done')).toBeInTheDocument());
    const items = within(region).getAllByRole('listitem', { name: /not done/ });
    expect(items).toHaveLength(5);

    expect(within(step(/Verify your email/)).getByRole('button', { name: /Resend/ })).toBeVisible();
    expect(within(step(/Get a pass/)).getByRole('link')).toHaveAttribute('href', '#pass');
    expect(within(step(/Install the extension/)).getByRole('link')).toHaveAttribute(
      'href',
      '#extension',
    );
    await waitFor(() =>
      expect(
        within(step(/Add a search filter/)).getAllByRole('button', { name: /^Add / }),
      ).toHaveLength(STARTER_FILTERS.length),
    );
    expect(within(step(/Record your first trade/)).getByRole('link')).toHaveAttribute(
      'href',
      '#extension',
    );
  });

  it('ticks each step from its own data', async () => {
    mockApi({ ...allDone(), trades: ok({ items: [], nextCursor: null }) });
    renderWithClient(<GettingStarted />);

    await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(screen.getByText('4 of 5 done')).toBeInTheDocument());
    expect(step(/Verify your email/)).toHaveAccessibleName(/done$/);
    expect(step(/Verify your email/)).not.toHaveAccessibleName(/not done/);
    expect(step(/Get a pass/)).not.toHaveAccessibleName(/not done/);
    expect(step(/Install the extension/)).not.toHaveAccessibleName(/not done/);
    expect(step(/Add a search filter/)).not.toHaveAccessibleName(/not done/);
    expect(step(/Record your first trade/)).toHaveAccessibleName(/not done/);
  });

  it('asks for the smallest page of trades', async () => {
    const get = mockApi();
    renderWithClient(<GettingStarted />);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/v1/trades', { params: { query: { limit: 1 } } }),
    );
  });

  it('hides the whole section once all five are done', async () => {
    const get = mockApi(allDone());
    renderWithClient(<GettingStarted />);

    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/v1/trades', expect.anything()));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument(),
    );
  });

  it('remembers "Hide" across renders', async () => {
    mockApi();
    const first = renderWithClient(<GettingStarted />);
    const region = await screen.findByRole('region', { name: 'Getting started' });
    await first.user.click(within(region).getByRole('button', { name: /Hide/ }));

    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(localStorage.getItem(GETTING_STARTED_HIDDEN_KEY)).toBe('1');
    first.unmount();

    renderWithClient(<GettingStarted />);
    // Filters load empty, so the small starter card is all that shows.
    expect(await screen.findByRole('region', { name: 'Starter filters' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('still renders when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mockApi();
    const { user } = renderWithClient(<GettingStarted />);
    const region = await screen.findByRole('region', { name: 'Getting started' });
    await user.click(within(region).getByRole('button', { name: /Hide/ }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('keeps the checklist when one query fails', async () => {
    mockApi({ ...allDone(), trades: fail('INTERNAL', 500) });
    renderWithClient(<GettingStarted />);

    const region = await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(within(region).getByText('4 of 5 done')).toBeInTheDocument());
    expect(step(/Record your first trade/)).toHaveAccessibleName(/not done/);
    expect(within(step(/Record your first trade/)).getByText(/Couldn't check/)).toBeInTheDocument();
  });

  it('shows "Included with a pass" when filters are not in the plan', async () => {
    mockApi({ filters: fail('FEATURE_NOT_IN_PLAN', 403) });
    renderWithClient(<GettingStarted />);

    await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() =>
      expect(within(step(/Add a search filter/)).getByText('Included with a pass')).toBeVisible(),
    );
    expect(step(/Add a search filter/)).toHaveAccessibleName(/not done/);
    expect(
      within(step(/Add a search filter/)).queryByText(/Couldn't check/),
    ).not.toBeInTheDocument();
    expect(within(step(/Add a search filter/)).queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it("doesn't ask for filters or trades when the plan has neither", async () => {
    const get = mockApi({
      subscription: ok({ subscription: null, license: null, entitlements: { features: [] } }),
    });
    renderWithClient(<GettingStarted />);

    await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() =>
      expect(within(step(/Add a search filter/)).getByText('Included with a pass')).toBeVisible(),
    );
    expect(step(/Record your first trade/)).toHaveAccessibleName(/not done/);
    expect(
      within(step(/Record your first trade/)).queryByText(/Couldn't check/),
    ).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/api/v1/filters');
    expect(get).not.toHaveBeenCalledWith('/api/v1/trades', expect.anything());
  });
});

describe('StarterFilters', () => {
  it('says these are starting points, not a promise of profit', async () => {
    mockApi();
    renderWithClient(<StarterFilters />);
    expect(await screen.findByText(/starting points/i)).toBeInTheDocument();
  });

  it('posts the starter name and criteria, then refreshes the filters', async () => {
    mockApi();
    const post = vi.spyOn(api, 'POST').mockImplementation((() =>
      Promise.resolve({
        data: savedFilter(STARTER_FILTERS[0]!.name, STARTER_FILTERS[0]!.filter),
        error: undefined,
        response: new Response(null, { status: 201 }),
      })) as never);
    const { user, queryClient } = renderWithClient(<StarterFilters />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const first = STARTER_FILTERS[0]!;
    await user.click(await screen.findByRole('button', { name: `Add ${first.name}` }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/filters', {
        body: { name: first.name, filter: first.filter },
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['filters'] }));
  });

  it('marks a starter "Added" when a saved filter has the same criteria', async () => {
    const second = STARTER_FILTERS[1]!;
    // Same criteria, different key order and name: still the same search.
    const reordered = Object.fromEntries(
      Object.entries(second.filter).reverse(),
    ) as SavedFilter['filter'];
    mockApi({ filters: ok([savedFilter('My own name', reordered)]) });
    renderWithClient(<StarterFilters />);

    const added = await screen.findByRole('button', { name: `${second.name} added` });
    expect(added).toBeDisabled();
    expect(added).toHaveTextContent('Added');
    expect(screen.getByRole('button', { name: `Add ${STARTER_FILTERS[0]!.name}` })).toBeEnabled();
  });
});
