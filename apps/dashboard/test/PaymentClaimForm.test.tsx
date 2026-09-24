import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { PaymentClaimForm, shownPlans, purchasablePlans } from '@/components/PaymentClaims.js';

import type { PlanDto } from '@sl/shared';

function plan(code: string, name: string, priceCents: number): PlanDto {
  return {
    id: `00000000-0000-0000-0000-00000000000${code.length}`,
    code,
    name,
    priceCents,
    currency: 'usd',
    interval: 'month',
    deviceLimit: 2,
    features: [],
    isLifetime: false,
  };
}

const PRO = plan('pro', 'Monthly', 999);
const ALL_PLANS = [
  plan('trial', 'Trial', 0),
  plan('basic', 'Basic', 499),
  PRO,
  plan('ultimate', 'Monthly + Mobile', 1399),
  plan('lifetime', 'Season', 2499),
];

function renderForm(onSubmitted = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentClaimForm plans={[PRO]} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSubmitted };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plan catalogue helpers', () => {
  it('shows every catalogued plan except retired ones and the trial', () => {
    expect(shownPlans(ALL_PLANS).map((p) => p.code)).toEqual(['pro', 'ultimate', 'lifetime']);
  });

  it('only offers available plans for purchase', () => {
    expect(purchasablePlans(ALL_PLANS).map((p) => p.code)).toEqual(['pro']);
  });
});

describe('PaymentClaimForm', () => {
  it('rejects a transaction ID that is not 17 letters and numbers, without calling the API', async () => {
    const post = vi.spyOn(api, 'POST');
    const { user } = renderForm();

    await user.type(screen.getByLabelText('PayPal transaction ID'), 'ABC-123');
    await user.click(screen.getByRole('button', { name: 'Submit transaction ID' }));

    expect(await screen.findByText(/17 letters and numbers\./)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('submits the claim with the ID trimmed and upper-cased, then reports back', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue({
      data: { id: 'x' },
      error: undefined,
      response: new Response(null, { status: 201 }),
    } as never);
    const { user, onSubmitted } = renderForm();

    await user.type(screen.getByLabelText('PayPal transaction ID'), '  8xy12345ab678901c ');
    await user.type(screen.getByLabelText('Note (optional)'), 'Paid from alt@example.com');
    await user.click(screen.getByRole('button', { name: 'Submit transaction ID' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith('/api/v1/payment-claims', {
      body: {
        planCode: 'pro',
        paypalTransactionId: '8XY12345AB678901C',
        note: 'Paid from alt@example.com',
      },
    });
  });

  it('does not send an empty note', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue({
      data: { id: 'x' },
      error: undefined,
      response: new Response(null, { status: 201 }),
    } as never);
    const { user, onSubmitted } = renderForm();

    await user.type(screen.getByLabelText('PayPal transaction ID'), '8XY12345AB678901C');
    await user.click(screen.getByRole('button', { name: 'Submit transaction ID' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]![1]).toEqual({
      body: { planCode: 'pro', paypalTransactionId: '8XY12345AB678901C' },
    });
  });

  it('keeps the form open and does not report success when the API refuses (e.g. 409)', async () => {
    vi.spyOn(api, 'POST').mockResolvedValue({
      data: undefined,
      error: { code: 'CONFLICT', message: 'That transaction ID was already submitted.' },
      response: new Response(null, { status: 409 }),
    } as never);
    const { user, onSubmitted } = renderForm();

    const input = screen.getByLabelText('PayPal transaction ID');
    await user.type(input, '8XY12345AB678901C');
    await user.click(screen.getByRole('button', { name: 'Submit transaction ID' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Submit transaction ID' })).not.toHaveAttribute(
        'aria-busy',
      ),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(input).toHaveValue('8XY12345AB678901C');
  });
});
