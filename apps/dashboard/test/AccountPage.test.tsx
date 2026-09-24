import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { daysLeft, describePass, formatPassDate } from '@/components/account/PassSummary.js';
import { AccountPage } from '@/pages/account/AccountPage.js';
import { useAuthStore } from '@/stores/auth.js';

import type { DeviceDto, PlanDto, SubscriptionDto, UserDto } from '@sl/shared';

vi.mock('@/hooks/useWsGateway.js', () => ({ useWsGateway: () => undefined }));
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

const PRO: PlanDto = {
  id: '00000000-0000-0000-0000-00000000000a',
  code: 'pro',
  name: 'Monthly',
  priceCents: 999,
  currency: 'usd',
  interval: 'month',
  deviceLimit: 2,
  features: [],
  isLifetime: false,
};

function subscription(overrides: Partial<SubscriptionDto>): SubscriptionDto {
  return {
    id: '00000000-0000-0000-0000-0000000000b1',
    plan: PRO,
    status: 'active',
    currentPeriodStart: '2026-09-24T12:00:00.000Z',
    currentPeriodEnd: '2026-10-24T12:00:00.000Z',
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    autoRenew: false,
    ...overrides,
  };
}

const DEVICES: DeviceDto[] = [
  {
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
  },
  {
    id: '00000000-0000-0000-0000-0000000000d2',
    name: 'Old laptop',
    browser: 'Chrome',
    os: 'macOS',
    extensionVersion: '1.0.0',
    status: 'active',
    firstSeenAt: '2026-08-01T12:00:00.000Z',
    lastSeenAt: '2026-08-20T12:00:00.000Z',
    trustedAt: null,
    isCurrent: false,
  },
];

function ok(data: unknown) {
  return Promise.resolve({ data, error: undefined, response: new Response(null, { status: 200 }) });
}

function mockApi(sub: SubscriptionDto | null, entitled = false) {
  return vi.spyOn(api, 'GET').mockImplementation(((path: string) => {
    switch (path) {
      case '/api/v1/subscriptions/me':
        return ok({ subscription: sub, license: null, devices: [], entitlements: [] });
      case '/api/v1/plans':
        return ok({ items: [PRO] });
      case '/api/v1/payment-claims':
        return ok({ items: [] });
      case '/api/v1/devices':
        return ok(DEVICES);
      case '/api/v1/downloads/extension/info':
        return ok({ available: true, entitled, version: '1.2.0', sizeBytes: 1024 * 1024 });
      default:
        return Promise.resolve({
          data: undefined,
          error: { code: 'NOT_FOUND', message: 'nope' },
          response: new Response(null, { status: 404 }),
        });
    }
  }) as never);
}

async function renderAccount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: AccountPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/account'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'My account' });
  return { user: userEvent.setup() };
}

beforeEach(() => {
  useAuthStore.getState().setSession(USER);
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

describe('describePass', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');

  it('formats dates as "24 Oct 2026"', () => {
    expect(formatPassDate('2026-10-24T12:00:00.000Z')).toBe('24 Oct 2026');
  });

  it('counts whole days left, rounding up and never below zero', () => {
    expect(daysLeft('2026-10-24T12:00:00.000Z', now)).toBe(30);
    expect(daysLeft('2026-09-24T18:00:00.000Z', now)).toBe(1);
    expect(daysLeft('2026-09-01T12:00:00.000Z', now)).toBe(0);
  });

  it('describes an active pass by its end date and days left', () => {
    expect(describePass(subscription({}), now)).toEqual({
      live: true,
      headline: 'Active until 24 Oct 2026',
      detail: '30 days left',
    });
  });

  it('describes a trial by the trial end', () => {
    const trial = subscription({
      status: 'trialing',
      currentPeriodEnd: null,
      trialEndsAt: '2026-10-01T12:00:00.000Z',
    });
    expect(describePass(trial, now)).toEqual({
      live: true,
      headline: 'Trial until 1 Oct 2026',
      detail: '7 days left',
    });
  });

  it('says so when there is no pass', () => {
    expect(describePass(null, now).headline).toBe('No active pass');
    expect(describePass(subscription({ status: 'expired' }), now)).toMatchObject({
      live: false,
      headline: 'No active pass',
    });
  });
});

describe('AccountPage', () => {
  it('shows the five sections in order', async () => {
    mockApi(subscription({}));
    await renderAccount();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Your pass',
      'Get the extension',
      'Buy or renew',
      'Devices',
      'Account and security',
    ]);
    expect(screen.getByText('player@example.com')).toBeInTheDocument();
  });

  it('shows the plan, status and expiry of an active pass', async () => {
    mockApi(subscription({ currentPeriodEnd: '2026-10-24T12:00:00.000Z' }));
    await renderAccount();

    const pass = screen.getByRole('region', { name: 'Your pass' });
    expect(await within(pass).findByText(/Active until 24 Oct 2026/)).toBeInTheDocument();
    expect(within(pass).getByText('Monthly')).toBeInTheDocument();
    expect(within(pass).getByText(/days? left|ends today/)).toBeInTheDocument();
  });

  it('shows the trial end for a trial', async () => {
    mockApi(
      subscription({
        status: 'trialing',
        currentPeriodEnd: null,
        trialEndsAt: '2026-10-01T12:00:00.000Z',
      }),
    );
    await renderAccount();

    const pass = screen.getByRole('region', { name: 'Your pass' });
    expect(await within(pass).findByText(/Trial until 1 Oct 2026/)).toBeInTheDocument();
  });

  it('shows "No active pass" and a trial button without a pass', async () => {
    mockApi(null);
    await renderAccount();

    const pass = screen.getByRole('region', { name: 'Your pass' });
    expect(await within(pass).findByText('No active pass')).toBeInTheDocument();
    expect(within(pass).getByRole('button', { name: 'Start 7-day free trial' })).toBeVisible();
  });

  it('points the not-entitled extension card at the buy section on this page', async () => {
    mockApi(null, false);
    await renderAccount();

    const extension = screen.getByRole('region', { name: 'Get the extension' });
    expect(
      await within(extension).findByRole('link', { name: 'See plans and pay' }),
    ).toHaveAttribute('href', '/account#buy');
    const buy = screen.getByRole('region', { name: 'Buy or renew' });
    expect(buy).toHaveAttribute('id', 'buy');
  });

  it('offers the download to an entitled user', async () => {
    mockApi(subscription({}), true);
    await renderAccount();

    const extension = screen.getByRole('region', { name: 'Get the extension' });
    expect(
      await within(extension).findByRole('button', { name: /Download Nova Trade v1\.2\.0/ }),
    ).toBeVisible();
  });

  it('explains that passes do not renew and links the refund policy', async () => {
    mockApi(subscription({}));
    await renderAccount();

    const buy = screen.getByRole('region', { name: 'Buy or renew' });
    expect(
      within(buy).getByText(/Passes are one-off payments and don't renew/),
    ).toBeInTheDocument();
    expect(within(buy).getByText(/Refunds are only available within 24 hours/)).toBeInTheDocument();
    for (const link of within(buy).getAllByRole('link', { name: 'Refund Policy' })) {
      expect(link).toHaveAttribute('href', '/refund-policy');
    }
    expect(await within(buy).findByRole('link', { name: /Pay with PayPal/ })).toBeVisible();
    expect(within(buy).getByRole('button', { name: 'Submit transaction ID' })).toBeVisible();
    expect(await within(buy).findByText('No payments sent yet')).toBeInTheDocument();
  });

  it('revokes another device, but not the current one', async () => {
    mockApi(subscription({}));
    const del = vi.spyOn(api, 'DELETE').mockImplementation((() => ok(undefined)) as never);
    const { user } = await renderAccount();

    const devices = screen.getByRole('region', { name: 'Devices' });
    await within(devices).findByText('Old laptop');
    const revoke = within(devices).getAllByRole('button', { name: 'Revoke' });
    expect(revoke).toHaveLength(1);

    await user.click(revoke[0]!);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('/api/v1/devices/{id}', {
        params: { path: { id: DEVICES[1]!.id } },
      }),
    );
  });

  it('keeps only the customer security settings', async () => {
    mockApi(subscription({}));
    await renderAccount();

    const security = screen.getByRole('region', { name: 'Account and security' });
    const titles = within(security)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual(['Email', 'Password', 'Two-factor authentication', 'Delete account']);
    expect(within(security).getByLabelText('Signed in as')).toHaveValue('player@example.com');
    expect(within(security).getByRole('button', { name: 'Change password' })).toBeVisible();
    expect(within(security).getByRole('button', { name: 'Turn on 2FA' })).toBeVisible();
  });
});
