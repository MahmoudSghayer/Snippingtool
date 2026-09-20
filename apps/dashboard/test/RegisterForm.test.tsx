import { zodResolver } from '@hookform/resolvers/zod';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import { Button, FormField, Input, PasswordInput } from '@sl/ui';

import { registerFormSchema } from '@/pages/auth/RegisterPage.js';

/** Exercises the real `registerFormSchema` (the same schema RegisterPage
 * submits through) end-to-end via react-hook-form + zodResolver + the
 * actual @sl/ui form components — not a schema-only unit test — so a
 * regression in either the schema or the FormField/Input error-wiring shows
 * up here. */
function TestForm({ onValid }: { onValid: (values: unknown) => void }) {
  const form = useForm({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: '', password: '', confirmPassword: '', deviceName: 'Test device' },
  });
  return (
    <form onSubmit={form.handleSubmit(onValid)}>
      <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input id="email" {...form.register('email')} />
      </FormField>
      <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
        <PasswordInput id="password" {...form.register('password')} />
      </FormField>
      <FormField label="Confirm" htmlFor="confirmPassword" error={form.formState.errors.confirmPassword?.message}>
        <PasswordInput id="confirmPassword" {...form.register('confirmPassword')} />
      </FormField>
      <Button type="submit">Submit</Button>
    </form>
  );
}

describe('registerFormSchema (RegisterPage)', () => {
  it('rejects a password under 12 characters and never calls onValid', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<TestForm onValid={onValid} />);

    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password'), 'short1');
    await user.type(screen.getByLabelText('Confirm'), 'short1');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords with the confirm-field error', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<TestForm onValid={onValid} />);

    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password'), 'correcthorse12');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorse13');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('accepts a valid, matching password and submits', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<TestForm onValid={onValid} />);

    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password'), 'correcthorse12');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorse12');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
  });
});
