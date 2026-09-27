import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { initialTimeZone, todayIn } from '@/components/account/timezone.js';
import { TradesSection } from '@/components/account/TradesSection.js';
import { downloadServerCsv } from '@/lib/csv.js';
import { useAuthStore } from '@/stores/auth.js';

import type { TradeListItem, TradeTotals, UserDto } from '@sl/shared';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/csv.js', () => ({ downloadServerCsv: vi.fn(() => Promise.resolve()) }));

const USER: UserDto = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'player@example.com',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  role: 'user',
  totpEnabled: false,
  timezone: 'Asia/Tokyo',
  timezoneSetAt: '2026-09-01T00:00:00.000Z',
  referralCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  adminRole: null,
  permissions: [],
};

function trade(overrides: Partial<TradeListItem>): TradeListItem {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    tradeId: 't-1',
    resourceId: 158023,
    assetId: null,
    rating: 91,
    buyPrice: 50_000,
    sellPrice: null,
    eaTax: 0,
    netProfit: null,
    status: 'bought',
    boughtAt: '2026-09-20T12:00:00.000Z',
    soldAt: null,
    cardName: 'Messi',
    ...overrides,
  };
}

const TRADES: TradeListItem[] = [
  trade({}),
  trade({
    id: '00000000-0000-0000-0000-0000000000a2',
    tradeId: 't-2',
    resourceId: 999999,
    cardName: null,
    rating: 75,
    status: 'sold',
    buyPrice: 10_000,
    sellPrice: 14_000,
    eaTax: 0.05,
    netProfit: 3_300,
    soldAt: '2026-09-21T12:00:00.000Z',
  }),
];

const TOTALS: TradeTotals = { count: 2, sold: 1, spent: 60_000, revenue: 14_000, netProfit: 3_300 };

function ok(data: unknown) {
  return Promise.resolve({ data, error: undefined, response: new Response(null, { status: 200 }) });
}

interface MockOptions {
  items?: TradeListItem[];
  totals?: TradeTotals;
  todayNet?: number;
}

function mockApi({ items = TRADES, totals = TOTALS, todayNet = 12_345 }: MockOptions = {}) {
  const get = vi.spyOn(api, 'GET').mockImplementation(((path: string) => {
    switch (path) {
      case '/api/v1/trades':
        return ok({ items, nextCursor: null });
      case '/api/v1/trades/totals':
        return ok(totals);
      case '/api/v1/analytics/me/profits':
        return ok({
          granularity: 'lifetime',
          items: [{ bucket: 'lifetime', netProfit: todayNet }],
        });
      default:
        return Promise.resolve({
          data: undefined,
          error: { code: 'NOT_FOUND', message: 'nope' },
          response: new Response(null, { status: 404 }),
        });
    }
  }) as never);
  const post = vi
    .spyOn(api, 'POST')
    .mockImplementation((() =>
      ok({ ...TRADES[0], status: 'sold', sellPrice: 60_000, netProfit: 7_000 })) as never);
  const patch = vi.spyOn(api, 'PATCH').mockImplementation(((
    _path: string,
    init: { body: { timezone: string } },
  ) =>
    ok({
      ...USER,
      timezone: init.body.timezone,
      timezoneSetAt: '2026-09-27T00:00:00.000Z',
    })) as never);
  return { get, post, patch };
}

/** The query params of every GET to `path`, in call order. */
function queriesTo(get: ReturnType<typeof mockApi>['get'], path: string) {
  return get.mock.calls
    .filter(([p]) => p === path)
    .map(([, init]) => (init as { params: { query: Record<string, unknown> } }).params.query);
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TradesSection />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

beforeEach(() => {
  useAuthStore.getState().setSession(USER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(downloadServerCsv).mockClear();
  useAuthStore.getState().clearSession();
});

/** Pretends the browser is in `zone`, so "defaults to the browser zone"
 * can't pass just because the test container runs in UTC. */
function browserIn(zone: string) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone };
  });
}

describe('initialTimeZone', () => {
  it("uses the account's zone once it was chosen, even UTC", () => {
    browserIn('Europe/London');
    expect(initialTimeZone({ timezone: 'UTC', timezoneSetAt: '2026-09-01T00:00:00.000Z' })).toBe(
      'UTC',
    );
    expect(
      initialTimeZone({ timezone: 'Asia/Tokyo', timezoneSetAt: '2026-09-01T00:00:00.000Z' }),
    ).toBe('Asia/Tokyo');
  });

  it("uses the browser's zone while the account's is still the signup default", () => {
    browserIn('Europe/London');
    expect(initialTimeZone({ timezone: 'UTC', timezoneSetAt: null })).toBe('Europe/London');
    expect(initialTimeZone(null)).toBe('Europe/London');
  });
});

describe('todayIn', () => {
  it("is the calendar day in the given zone, not the browser's", () => {
    const at = new Date('2026-09-10T21:00:00.000Z');
    expect(todayIn('Asia/Tokyo', at)).toBe('2026-09-11');
    expect(todayIn('America/Los_Angeles', at)).toBe('2026-09-10');
    expect(todayIn('UTC', at)).toBe('2026-09-10');
  });
});

describe('TradesSection', () => {
  it('lists trades by card name and rating, falling back to #resourceId', async () => {
    mockApi();
    renderSection();

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Messi')).toBeInTheDocument();
    expect(within(table).getByText('91')).toBeInTheDocument();
    expect(within(table).getByText('#999999')).toBeInTheDocument();
    // The same trades as cards for narrow screens.
    const cards = screen.getByRole('list', { name: 'Trades' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
  });

  it('never sorts the paged table on the client', async () => {
    mockApi();
    renderSection();
    const table = await screen.findByRole('table');
    await within(table).findByText('Messi');
    // DataTable renders a sort button in every sortable header.
    expect(within(table).queryAllByRole('button', { name: /bought|buy|net/i })).toHaveLength(0);
  });

  it("shows today's net profit, asked for in the trader's time zone", async () => {
    const { get } = mockApi({ todayNet: 12_345 });
    renderSection();

    const today = await screen.findByRole('group', { name: 'Net profit today' });
    expect(await within(today).findByText('+12,345')).toBeInTheDocument();
    const [query] = queriesTo(get, '/api/v1/analytics/me/profits');
    const day = todayIn('Asia/Tokyo');
    expect(query).toEqual({ from: day, to: day, granularity: 'lifetime', tz: 'Asia/Tokyo' });
  });

  it('shows totals for the whole filter', async () => {
    mockApi();
    renderSection();

    const spent = await screen.findByRole('group', { name: 'Spent' });
    expect(await within(spent).findByText('60,000')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Revenue' })).getByText('14,000'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('group', { name: 'Net profit' })).getByText('+3,300'),
    ).toBeVisible();
  });

  it('filters by status and purchase dates, on the server, in the chosen time zone', async () => {
    const { get } = mockApi();
    const { user } = renderSection();
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('Status'), 'sold');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    await user.selectOptions(screen.getByLabelText('Order'), 'asc');

    await waitFor(() => {
      expect(queriesTo(get, '/api/v1/trades').at(-1)).toEqual({
        limit: 25,
        status: 'sold',
        from: '2026-09-01',
        tz: 'Asia/Tokyo',
        order: 'asc',
      });
    });
    expect(queriesTo(get, '/api/v1/trades/totals').at(-1)).toEqual({
      status: 'sold',
      from: '2026-09-01',
      tz: 'Asia/Tokyo',
    });
  });

  it('exports the filtered trades as CSV from the server', async () => {
    mockApi();
    const { user } = renderSection();
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('Status'), 'sold');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(downloadServerCsv).toHaveBeenCalledWith(
      'trades.csv',
      '/api/v1/trades/export.csv?status=sold&tz=Asia%2FTokyo',
    );
  });

  it('defaults the time zone to the browser zone and saves a new choice', async () => {
    browserIn('Europe/London');
    useAuthStore.getState().setSession({ ...USER, timezone: 'UTC', timezoneSetAt: null });
    const { patch, get } = mockApi();
    const { user } = renderSection();
    await screen.findByRole('table');

    const picker = screen.getByLabelText('Time zone') as HTMLSelectElement;
    expect(picker.value).toBe('Europe/London');
    expect(queriesTo(get, '/api/v1/trades').at(-1)).toMatchObject({ tz: 'Europe/London' });
    expect(within(picker).getByRole('option', { name: 'Europe/London' })).toBeInTheDocument();

    await user.selectOptions(picker, 'America/New_York');
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/v1/users/me', {
        body: { timezone: 'America/New_York' },
      }),
    );
    await waitFor(() =>
      expect(queriesTo(get, '/api/v1/analytics/me/profits').at(-1)).toMatchObject({
        tz: 'America/New_York',
      }),
    );
    expect(useAuthStore.getState().user?.timezone).toBe('America/New_York');
  });

  it('keeps a deliberately saved UTC, in the picker and in every query', async () => {
    browserIn('Europe/London');
    useAuthStore
      .getState()
      .setSession({ ...USER, timezone: 'UTC', timezoneSetAt: '2026-09-01T00:00:00.000Z' });
    const { get, patch } = mockApi();
    renderSection();
    await screen.findByRole('table');

    expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe('UTC');
    await waitFor(() =>
      expect(queriesTo(get, '/api/v1/analytics/me/profits').at(-1)).toMatchObject({ tz: 'UTC' }),
    );
    expect(queriesTo(get, '/api/v1/trades').at(-1)).toMatchObject({ tz: 'UTC' });
    expect(queriesTo(get, '/api/v1/trades/totals').at(-1)).toMatchObject({ tz: 'UTC' });
    // Nothing is overwritten just by opening the page.
    expect(patch).not.toHaveBeenCalled();
  });

  it('offers the extension when there are no trades yet', async () => {
    mockApi({ items: [], totals: { count: 0, sold: 0, spent: 0, revenue: 0, netProfit: 0 } });
    renderSection();

    expect(await screen.findByText('No trades yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get the extension' })).toHaveAttribute(
      'href',
      '#extension',
    );
  });
});

describe('Record sale', () => {
  async function openDialog() {
    const api = mockApi();
    const { user } = renderSection();
    const table = await screen.findByRole('table');
    await within(table).findByText('Messi');
    // Only the unsold trade can be recorded.
    const buttons = within(table).getAllByRole('button', { name: /Record sale/ });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Record sale' });
    return { user, dialog, ...api };
  }

  it('rejects a price below 200 or above 15,000,000, or one that is not a price', async () => {
    const { user, dialog, post } = await openDialog();
    const input = within(dialog).getByLabelText('Sale price');
    const submit = within(dialog).getByRole('button', { name: 'Record sale' });

    await user.type(input, '150');
    expect(within(dialog).getByText('The lowest sale price is 200 coins.')).toBeVisible();
    expect(submit).toBeDisabled();

    await user.clear(input);
    await user.type(input, '16m');
    expect(within(dialog).getByText('The highest sale price is 15,000,000 coins.')).toBeVisible();
    expect(submit).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'lots');
    expect(within(dialog).getByText('Enter a price like 60k, 1.2m or 60,000.')).toBeVisible();
    expect(submit).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('reads 60k as 60,000, previews tax and net, and records it', async () => {
    const { user, dialog, post } = await openDialog();
    await user.type(within(dialog).getByLabelText('Sale price'), '60k');

    // 60,000 - 5% tax (3,000) - 50,000 bought = 7,000.
    expect(within(dialog).getByText('60,000')).toBeVisible();
    expect(within(dialog).getByText('-3,000')).toBeVisible();
    expect(within(dialog).getByText('+7,000')).toBeVisible();
    expect(within(dialog).queryByText(/more than half/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Record sale' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/trades/{id}/close', {
        params: { path: { id: TRADES[0]!.id } },
        body: { sellPrice: 60_000 },
      }),
    );
  });

  it('warns, without blocking, when the sale loses more than half the buy price', async () => {
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Sale price'), '20k');

    // 20,000 - 1,000 - 50,000 = -31,000: more than half of 50,000.
    expect(within(dialog).getByText('-31,000')).toBeVisible();
    expect(within(dialog).getByText(/more than half of what you paid/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Record sale' })).toBeEnabled();
  });

  it("uses the trade's own tax rate in the preview", async () => {
    const custom = trade({ eaTax: 0.1 });
    vi.spyOn(api, 'GET').mockImplementation(((path: string) =>
      path === '/api/v1/trades'
        ? ok({ items: [custom], nextCursor: null })
        : path === '/api/v1/trades/totals'
          ? ok(TOTALS)
          : ok({ granularity: 'lifetime', items: [] })) as never);
    const { user } = renderSection();
    const table = await screen.findByRole('table');
    await user.click(await within(table).findByRole('button', { name: /Record sale/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Record sale' });
    await user.type(within(dialog).getByLabelText('Sale price'), '60,000');
    expect(within(dialog).getByText('-6,000')).toBeVisible();
    expect(within(dialog).getByText('+4,000')).toBeVisible();
  });
});
