import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ACCEPT_TERMS_ERROR, RegisterForm } from '@/pages/auth/RegisterPage.js';

/** Renders the real `RegisterForm` (the same component RegisterPage mounts,
 * minus the router link and the API call), so a regression in the schema,
 * the terms checkbox or the FormField error wiring shows up here. */
function setup() {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<RegisterForm onSubmit={onSubmit} defaultDeviceName="Test device" />);
  return { user, onSubmit };
}

async function fillValid(user: ReturnType<typeof userEvent.setup>, password = 'correcthorse12') {
  await user.type(screen.getByLabelText('Email'), 'person@example.com');
  await user.type(screen.getByLabelText('Password', { selector: 'input' }), password);
  await user.type(screen.getByLabelText('Confirm password', { selector: 'input' }), password);
}

describe('RegisterForm', () => {
  it('rejects a password under 12 characters and never submits', async () => {
    const { user, onSubmit } = setup();

    await fillValid(user, 'short1');
    await user.click(screen.getByRole('checkbox', { name: /I accept the/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords with the confirm-field error', async () => {
    const { user, onSubmit } = setup();

    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'correcthorse12');
    await user.type(
      screen.getByLabelText('Confirm password', { selector: 'input' }),
      'correcthorse13',
    );
    await user.click(screen.getByRole('checkbox', { name: /I accept the/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks submit until the terms checkbox is ticked, with an accessible error', async () => {
    const { user, onSubmit } = setup();

    await fillValid(user);
    const checkbox = screen.getByRole('checkbox', { name: /I accept the/ });
    expect(checkbox).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(ACCEPT_TERMS_ERROR);
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(checkbox).toHaveAttribute('aria-describedby', error.id);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ acceptTerms: true });
  });

  it('links the Terms of Service and Refund Policy in a new tab and states bans are not refundable', () => {
    setup();

    const terms = screen.getByRole('link', { name: 'Terms of Service' });
    const refunds = screen.getByRole('link', { name: 'Refund Policy' });
    expect(terms).toHaveAttribute('href', '/terms');
    expect(refunds).toHaveAttribute('href', '/refund-policy');
    for (const link of [terms, refunds]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener');
    }
    expect(
      screen.getByText('Bans are your own risk and are never refundable.'),
    ).toBeInTheDocument();
  });

  it('accepts valid, matching passwords with the terms accepted and submits', async () => {
    const { user, onSubmit } = setup();

    await fillValid(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept the/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      email: 'person@example.com',
      deviceName: 'Test device',
      acceptTerms: true,
    });
  });
});
