import { passwordSchema } from '@sl/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { generatePassword } from '@/lib/password.js';
import { UsersPage } from '@/pages/admin/UsersPage.js';
import { useAuthStore } from '@/stores/auth.js';

import type { Permission, UserDto } from '@sl/shared';

// The page reads `?q=` from the router; these tests render it on its own.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSearch: () => ({}),
}));

function userDto(overrides: Partial<UserDto>): UserDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'someone@example.com',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    role: 'user',
    totpEnabled: false,
    timezone: 'UTC',
    timezoneSetAt: null,
    referralCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    adminRole: null,
    permissions: [],
    ...overrides,
  };
}

const EXISTING = userDto({ id: '11111111-1111-4111-8111-111111111111', email: 'old@example.com' });
const CREATED = userDto({
  id: '22222222-2222-4222-8222-222222222222',
  email: 'new.member@example.com',
  createdAt: '2026-10-15T12:00:00.000Z',
});

function signInAdmin(permissions: Permission[]) {
  useAuthStore.getState().setSession(
    userDto({
      email: 'admin@example.com',
      role: 'admin',
      totpEnabled: true,
      adminRole: 'support',
      permissions,
    }),
  );
}

function ok(data: unknown, status = 200) {
  return { data, error: undefined, response: new Response(null, { status }) } as never;
}

function failed(status: number, error: unknown) {
  return { data: undefined, error, response: new Response(null, { status }) } as never;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <UsersPage />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

let get: ReturnType<typeof vi.spyOn>;
let post: ReturnType<typeof vi.spyOn>;
let listed: UserDto[];

beforeEach(() => {
  listed = [EXISTING];
  get = vi
    .spyOn(api, 'GET')
    .mockImplementation((async (path: string) =>
      path === '/api/v1/admin/users'
        ? ok({ items: listed, nextCursor: null })
        : ok({ items: [], nextCursor: null })) as never);
  post = vi.spyOn(api, 'POST').mockImplementation((async () => {
    listed = [CREATED, EXISTING];
    return ok(CREATED, 201);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

describe('admin UsersPage: Create account', () => {
  it('hides the Create account button without users.create', async () => {
    signInAdmin(['users.read', 'users.write']);
    renderPage();

    expect(await screen.findByText('old@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
  });

  it('creates an account with a generated password, refreshes the list and opens the new account', async () => {
    signInAdmin(['users.read', 'users.create']);
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create account' });

    await user.type(within(dialog).getByLabelText('Email'), 'new.member@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    const passwordInput = within(dialog).getByLabelText('Password') as HTMLInputElement;
    const generated = passwordInput.value;
    expect(passwordSchema.safeParse(generated).success).toBe(true);
    expect(passwordInput).toHaveAttribute('type', 'password');

    await user.click(within(dialog).getByRole('button', { name: 'Show password' }));
    expect(passwordInput).toHaveAttribute('type', 'text');

    await user.click(within(dialog).getByRole('button', { name: 'Copy password' }));
    expect(await navigator.clipboard.readText()).toBe(generated);

    await user.type(within(dialog).getByLabelText('Reason'), 'Paid by bank transfer');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/admin/users', {
        body: {
          email: 'new.member@example.com',
          password: generated,
          emailVerified: true,
          reason: 'Paid by bank transfer',
        },
      }),
    );
    // The new account's drawer opens and the list is fetched again.
    expect(await screen.findByRole('dialog', { name: 'new.member@example.com' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Create account' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(get.mock.calls.filter(([path]) => path === '/api/v1/admin/users')).toHaveLength(2),
    );
    // The table sits behind the open drawer, which aria-hides the rest of
    // the page, hence `hidden: true`.
    expect(
      await screen.findByRole('cell', { name: 'new.member@example.com', hidden: true }),
    ).toBeInTheDocument();
  });

  it('sends emailVerified: false when the admin unticks it', async () => {
    signInAdmin(['users.read', 'users.create']);
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create account' });
    await user.type(within(dialog).getByLabelText('Email'), 'new.member@example.com');
    await user.type(within(dialog).getByLabelText('Password'), 'typed-by-hand-123');
    await user.click(within(dialog).getByRole('checkbox', { name: /Email already verified/ }));
    await user.type(within(dialog).getByLabelText('Reason'), 'they confirm it themselves');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/admin/users', {
        body: {
          email: 'new.member@example.com',
          password: 'typed-by-hand-123',
          emailVerified: false,
          reason: 'they confirm it themselves',
        },
      }),
    );
  });

  it('does not submit a weak password or a missing reason', async () => {
    signInAdmin(['users.read', 'users.create']);
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create account' });
    await user.type(within(dialog).getByLabelText('Email'), 'new.member@example.com');
    await user.type(within(dialog).getByLabelText('Password'), 'short1');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    expect(
      await within(dialog).findByText('Password must be at least 12 characters'),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByRole('alert')).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the API error when the email is already taken and keeps the form open', async () => {
    signInAdmin(['users.read', 'users.create']);
    post.mockResolvedValue(
      failed(409, {
        code: 'CONFLICT',
        message: 'An account with this email already exists.',
        requestId: 'req-1',
      }),
    );
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create account' });
    await user.type(within(dialog).getByLabelText('Email'), 'old@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    await user.type(within(dialog).getByLabelText('Reason'), 'duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    );
    expect(screen.getByRole('dialog', { name: 'Create account' })).toBeVisible();
  });
});

describe('generatePassword', () => {
  it('always satisfies the shared password rules, with every character class', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(20);
      expect(passwordSchema.safeParse(password).success).toBe(true);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });
});
