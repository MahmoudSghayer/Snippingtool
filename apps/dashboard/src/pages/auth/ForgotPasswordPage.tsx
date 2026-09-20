import { zodResolver } from '@hookform/resolvers/zod';
import { passwordResetRequestSchema } from '@sl/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@sl/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';


import { api } from '@/api/client.js';

type FormValues = { email: string };

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(passwordResetRequestSchema), defaultValues: { email: '' } });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      await api.POST('/api/v1/auth/password/reset-request', { body: { email: values.email } });
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Check your inbox</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-2">
            If that email has an account, a password reset link is on its way. The link expires in 1 hour.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Reset your password</CardTitle>
        <p className="text-xs text-ink-2">We'll email you a link to choose a new one.</p>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" autoFocus {...form.register('email')} />
          </FormField>
          <Button type="submit" loading={submitting} className="w-full">
            Send reset link
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-ink-2">
          <Link to="/login" className="text-gold hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default ForgotPasswordPage;
