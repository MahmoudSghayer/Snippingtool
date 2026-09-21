import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@sl/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, PasswordInput } from '@sl/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';

const formSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
type FormValues = z.infer<typeof formSchema>;

export function ResetPasswordPage() {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  if (!search.token) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Invalid reset link</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-2">
            This password reset link is missing its token. Request a new one.
          </p>
          <Link
            to="/forgot-password"
            className="mt-4 inline-block text-sm text-gold underline underline-offset-2 hover:text-gold/80"
          >
            Request a new link
          </Link>
        </CardContent>
      </Card>
    );
  }

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      const { error } = await api.POST('/api/v1/auth/password/reset-confirm', {
        body: { token: search.token!, password: values.password },
      });
      if (error) {
        toast.error('Couldn’t reset your password', { description: apiErrorMessage(error) });
        return;
      }
      toast.success('Password updated. Please sign in again.');
      await navigate({ to: '/login' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            label="New password"
            htmlFor="password"
            hint="At least 12 characters, with a letter and a digit."
            error={form.formState.errors.password?.message}
          >
            <PasswordInput
              id="password"
              autoComplete="new-password"
              autoFocus
              {...form.register('password')}
            />
          </FormField>
          <FormField
            label="Confirm password"
            htmlFor="confirmPassword"
            error={form.formState.errors.confirmPassword?.message}
          >
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              {...form.register('confirmPassword')}
            />
          </FormField>
          <Button type="submit" loading={submitting} className="w-full">
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default ResetPasswordPage;
