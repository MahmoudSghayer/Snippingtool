import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { emailSchema } from '@sl/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@sl/ui';

import { api, apiErrorMessage } from '@/api/client.js';

const resendSchema = z.object({ email: emailSchema });
type ResendForm = z.infer<typeof resendSchema>;

/** Handles both states of `docs/07-dashboard.md`'s "verify-email notice,
 * resend": with `?token=` (the link from the verification email) it
 * verifies immediately; without one it shows the "check your inbox" notice
 * plus a resend form. */
export function VerifyEmailPage() {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [status, setStatus] = useState<'idle' | 'verifying' | 'verified' | 'error'>(search.token ? 'verifying' : 'idle');
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ResendForm>({ resolver: zodResolver(resendSchema), defaultValues: { email: '' } });

  useEffect(() => {
    if (!search.token) return;
    let cancelled = false;
    void (async () => {
      const { error } = await api.POST('/auth/verify-email', { body: { token: search.token! } });
      if (cancelled) return;
      setStatus(error ? 'error' : 'verified');
    })();
    return () => {
      cancelled = true;
    };
  }, [search.token]);

  async function onResend(values: ResendForm) {
    setSubmitting(true);
    try {
      await api.POST('/auth/resend-verification', { body: { email: values.email } });
      // Always show the same message regardless of whether the account
      // exists — matches docs/04-auth.md's own "never reveal account
      // existence" framing for this endpoint.
      toast.success('If that email has an account, a new link is on its way.');
    } catch (err) {
      toast.error('Something went wrong', { description: apiErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'verifying') {
    return (
      <Card>
        <CardContent className="pt-5 text-center text-sm text-ink-2">Verifying your email…</CardContent>
      </Card>
    );
  }

  if (status === 'verified') {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Email verified</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-2">Your email is confirmed. You can sign in now.</p>
          <Button className="mt-4 w-full" onClick={() => void navigate({ to: '/login' })}>
            Continue to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>{status === 'error' ? 'That link has expired' : 'Check your inbox'}</CardTitle>
        <p className="text-xs text-ink-2">
          {status === 'error'
            ? 'Request a new verification link below.'
            : "We've sent a verification link to your email. Didn't get it?"}
        </p>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onResend)}>
          <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          </FormField>
          <Button type="submit" variant="outline" loading={submitting} className="w-full">
            Resend verification email
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default VerifyEmailPage;
