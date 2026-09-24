import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { PaymentsPage } from '@/pages/admin/PaymentsPage.js';
import { useAuthStore } from '@/stores/auth.js';

import type { AdminPaymentClaimDto, Permission, UserDto } from '@sl/shared';

const CLAIM: AdminPaymentClaimDto = {
  id: '11111111-1111-4111-8111-111111111111',
  planCode: 'pro',
  planName: 'Monthly',
  amountCents: 999,
  currency: 'usd',
  paypalTransactionId: '8XY12345AB678901C',
  note: 'Paid from alt@example.com',
  status: 'pending',
  rejectReason: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  reviewedAt: null,
  user: { id: '22222222-2222-4222-8222-222222222222', email: 'buyer@example.com' },
};

function signInAdmin(permissions: Permission[]) {
  const user: UserDto = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@example.com',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    role: 'admin',
    totpEnabled: true,
    timezone: 'UTC',
    referralCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    adminRole: null,
    permissions,
  };
  useAuthStore.getState().setSession(user);
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) } as never;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentsPage />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

let get: ReturnType<typeof vi.spyOn>;
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  get = vi.spyOn(api, 'GET').mockResolvedValue(ok({ items: [CLAIM], nextCursor: null }));
  post = vi.spyOn(api, 'POST').mockResolvedValue(ok({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

describe('admin PaymentsPage', () => {
  it('lists pending claims by default with the buyer, amount and transaction ID', async () => {
    signInAdmin(['subscriptions.read', 'subscriptions.write']);
    renderPage();

    expect(await screen.findByText('buyer@example.com')).toBeInTheDocument();
    expect(screen.getByText('8XY12345AB678901C')).toBeInTheDocument();
    expect(screen.getByText('$9.99')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/v1/admin/payment-claims', {
      params: { query: { status: 'pending', cursor: undefined, limit: 50 } },
    });
  });

  it('approves only after the admin confirms they checked PayPal', async () => {
    signInAdmin(['subscriptions.read', 'subscriptions.write']);
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Check the PayPal account first/);
    expect(within(dialog).getByText('8XY12345AB678901C')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'I checked PayPal, approve' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/admin/payment-claims/{id}/approve', {
        params: { path: { id: CLAIM.id } },
      }),
    );
  });

  it('rejects with the reason the admin typed, and requires one', async () => {
    signInAdmin(['subscriptions.read', 'subscriptions.write']);
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject payment' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Reason'), 'No payment with this ID');
    await user.click(confirm);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/admin/payment-claims/{id}/reject', {
        params: { path: { id: CLAIM.id } },
        body: { reason: 'No payment with this ID' },
      }),
    );
  });

  it('hides Approve and Reject without subscriptions.write', async () => {
    signInAdmin(['subscriptions.read']);
    renderPage();

    expect(await screen.findByText('buyer@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });
});
