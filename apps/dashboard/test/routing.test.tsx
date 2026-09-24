// Who lands where: admins on the admin dashboard, customers on /account,
// retired customer routes redirected, and the admin shell kept from
// customers. Drives the real route tree (src/router.tsx) in memory.
import { TooltipProvider } from '@sl/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { resetBootstrap } from '@/lib/authBootstrap.js';
import { routeTree } from '@/router.js';
import { homePathFor, postLoginPath, RETIRED_CUSTOMER_PATHS } from '@/routes/access.js';
import { useAuthStore } from '@/stores/auth.js';

import type { UserDto } from '@sl/shared';

vi.mock('@/hooks/useWsGateway.js', () => ({ useWsGateway: () => undefined }));
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

const CUSTOMER: UserDto = {
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

const ADMIN: UserDto = {
  ...CUSTOMER,
  id: '00000000-0000-0000-0000-000000000002',
  email: 'admin@example.com',
  role: 'admin',
  totpEnabled: true,
  adminRole: 'super_admin',
  permissions: ['analytics.read', 'users.read', 'subscriptions.read', 'audit.read'],
};

const ADMIN_SESSION = { adminRole: ADMIN.adminRole, permissions: ADMIN.permissions };

/** The session the mocked GET /users/me returns; null means signed out. */
let sessionUser: UserDto | null = null;

function mockApi() {
  vi.spyOn(api, 'GET').mockImplementation(((path: string) => {
    if (path === '/api/v1/users/me') {
      return Promise.resolve(
        sessionUser
          ? { data: sessionUser, error: undefined, response: new Response(null, { status: 200 }) }
          : {
              data: undefined,
              error: { code: 'UNAUTHORIZED', message: 'Sign in' },
              response: new Response(null, { status: 401 }),
            },
      );
    }
    // Every page's own data: an empty error is enough for these tests.
    return Promise.resolve({
      data: undefined,
      error: { code: 'NOT_FOUND', message: 'Not in this test' },
      response: new Response(null, { status: 404 }),
    });
  }) as never);
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup() };
}

async function expectPath(router: ReturnType<typeof renderAt>['router'], pathname: string) {
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname), { timeout: 3000 });
}

beforeEach(() => {
  sessionUser = null;
  resetBootstrap();
  useAuthStore.setState({ user: null, admin: null, status: 'loading' });
  mockApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('homePathFor / postLoginPath', () => {
  it('sends admins to the admin dashboard and everyone else to /account', () => {
    expect(homePathFor(null)).toBe('/account');
    expect(homePathFor(ADMIN_SESSION)).toBe('/admin');
  });

  it("sends an admin without the overview's permission to the first page they can open", () => {
    expect(homePathFor({ adminRole: 'support', permissions: ['users.read'] })).toBe('/admin/users');
  });

  it('respects a same-origin returnTo', () => {
    expect(postLoginPath('/account#buy', null)).toBe('/account#buy');
    expect(postLoginPath('/admin/users?q=x', ADMIN_SESSION)).toBe('/admin/users?q=x');
  });

  it('ignores a returnTo that leaves the site, loops to /login, or is admin-only', () => {
    expect(postLoginPath(undefined, null)).toBe('/account');
    expect(postLoginPath('https://evil.example', null)).toBe('/account');
    expect(postLoginPath('//evil.example/account', null)).toBe('/account');
    expect(postLoginPath('/login?returnTo=/x', ADMIN_SESSION)).toBe('/admin');
    expect(postLoginPath('/admin/users', null)).toBe('/account');
  });
});

describe('signing in', () => {
  async function signIn(path = '/login') {
    vi.spyOn(api, 'POST').mockImplementation(((p: string) =>
      Promise.resolve(
        p === '/api/v1/auth/login'
          ? { data: { status: 'ok' }, error: undefined, response: new Response(null) }
          : { data: undefined, error: undefined, response: new Response(null) },
      )) as never);
    const { router, user } = renderAt(path);
    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    return router;
  }

  it('takes a customer to /account', async () => {
    sessionUser = CUSTOMER;
    const router = await signIn();
    await expectPath(router, '/account');
    expect(await screen.findByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
  });

  it('takes an admin to /admin', async () => {
    sessionUser = ADMIN;
    const router = await signIn();
    await expectPath(router, '/admin');
  });

  it('goes back to the returnTo page when there is one', async () => {
    sessionUser = CUSTOMER;
    const router = await signIn('/login?returnTo=%2Faccount%23buy');
    await expectPath(router, '/account');
    expect(router.state.location.hash).toBe('buy');
  });
});

describe('retired customer routes', () => {
  it.each(RETIRED_CUSTOMER_PATHS)('%s redirects a customer to /account', async (path) => {
    sessionUser = CUSTOMER;
    const { router } = renderAt(path);
    await expectPath(router, '/account');
  });

  it('/dashboard redirects an admin to /admin', async () => {
    sessionUser = ADMIN;
    const { router } = renderAt('/dashboard');
    await expectPath(router, '/admin');
  });

  it('/dashboard sends a signed-out visitor to /login', async () => {
    const { router } = renderAt('/dashboard');
    await expectPath(router, '/login');
  });
});

describe('access', () => {
  it('/account sends a signed-out visitor to /login with a way back', async () => {
    const { router } = renderAt('/account');
    await expectPath(router, '/login');
    expect(router.state.location.search).toEqual({ returnTo: '/account' });
  });

  it('shows /account in the website layout, not the admin shell', async () => {
    sessionUser = CUSTOMER;
    renderAt('/account');
    await screen.findByRole('heading', { level: 1, name: 'My account' });
    expect(screen.getByRole('link', { name: 'Nova Trade home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
  });

  it('never shows the admin shell to a customer', async () => {
    sessionUser = CUSTOMER;
    renderAt('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('shows only admin navigation in the admin shell', async () => {
    sessionUser = ADMIN;
    renderAt('/admin');
    expect((await screen.findAllByRole('link', { name: 'Users' })).length).toBeGreaterThan(0);
    for (const label of ['Dashboard', 'Trades', 'Bot', 'Analytics', 'Settings']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('keeps the email links working inside the website layout', async () => {
    vi.spyOn(api, 'POST').mockImplementation((() =>
      Promise.resolve({
        data: undefined,
        error: { code: 'INVALID_TOKEN', message: 'Expired' },
        response: new Response(null, { status: 400 }),
      })) as never);
    const verify = renderAt('/verify-email?token=abc');
    expect(await screen.findByText('That link has expired')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Nova Trade home' })).toBeVisible();
    expect(verify.router.state.location.pathname).toBe('/verify-email');
  });
});
