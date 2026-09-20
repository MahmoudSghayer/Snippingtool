import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { emailSchema } from '@sl/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, PasswordInput } from '@sl/ui';

import { api, apiErrorMessage } from '@/api/client.js';
import { ensureBootstrapped, resetBootstrap } from '@/lib/authBootstrap.js';
import { buildDevicePayload, defaultDeviceName } from '@/lib/device.js';

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
  deviceName: z.string().min(1, 'Give this device a name').max(120),
});
type CredentialsForm = z.infer<typeof credentialsSchema>;

const mfaSchema = z.object({
  code: z.string().min(6, 'Enter the 6-digit code, or a recovery code'),
});
type MfaForm = z.infer<typeof mfaSchema>;

/** POST /auth/login -> either tokens directly, or `mfa_required` (device
 * fingerprint accompanies the *first* call per docs/04-auth.md; there is no
 * separate device-registration round trip in the login flow, so the "device
 * name prompt" step lives inline on the credentials form below). */
export function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { returnTo?: string };
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const credentialsForm = useForm<CredentialsForm>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '', deviceName: defaultDeviceName() },
  });

  const mfaForm = useForm<MfaForm>({ resolver: zodResolver(mfaSchema), defaultValues: { code: '' } });

  async function completeSession() {
    resetBootstrap();
    await ensureBootstrapped();
    const dest = search.returnTo && search.returnTo.startsWith('/') ? search.returnTo : '/dashboard';
    await navigate({ to: dest });
  }

  async function onSubmitCredentials(values: CredentialsForm) {
    setSubmitting(true);
    try {
      const { data, error } = await api.POST('/auth/login', {
        body: { email: values.email, password: values.password, device: buildDevicePayload(values.deviceName) },
      });
      if (error) {
        toast.error('Couldn’t sign in', { description: apiErrorMessage(error) });
        return;
      }
      if (data.status === 'mfa_required') {
        setMfaTicket(data.mfaTicket);
        return;
      }
      toast.success('Welcome back');
      await completeSession();
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitMfa(values: MfaForm) {
    if (!mfaTicket) return;
    setSubmitting(true);
    try {
      const { error } = await api.POST('/auth/mfa/verify', { body: { mfaTicket, code: values.code } });
      if (error) {
        toast.error('Verification failed', { description: apiErrorMessage(error) });
        return;
      }
      toast.success('Welcome back');
      await completeSession();
    } finally {
      setSubmitting(false);
    }
  }

  if (mfaTicket) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Two-factor verification</CardTitle>
          <p className="text-xs text-ink-2">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={mfaForm.handleSubmit(onSubmitMfa)}>
            <FormField label="Verification code" htmlFor="code" error={mfaForm.formState.errors.code?.message}>
              <Input id="code" autoFocus inputMode="numeric" autoComplete="one-time-code" {...mfaForm.register('code')} />
            </FormField>
            <Button type="submit" loading={submitting} className="w-full">
              Verify
            </Button>
            <button
              type="button"
              className="text-xs text-ink-2 underline hover:text-ink"
              onClick={() => setMfaTicket(null)}
            >
              Use a different account
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Sign in</CardTitle>
        <p className="text-xs text-ink-2">Track your snipes, profit and subscription.</p>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={credentialsForm.handleSubmit(onSubmitCredentials)}>
          <FormField label="Email" htmlFor="email" error={credentialsForm.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" autoFocus {...credentialsForm.register('email')} />
          </FormField>
          <FormField label="Password" htmlFor="password" error={credentialsForm.formState.errors.password?.message}>
            <PasswordInput id="password" autoComplete="current-password" {...credentialsForm.register('password')} />
          </FormField>
          <FormField
            label="This device"
            htmlFor="deviceName"
            hint="Shown in Settings → Sessions so you can recognise and revoke it later."
            error={credentialsForm.formState.errors.deviceName?.message}
          >
            <Input id="deviceName" {...credentialsForm.register('deviceName')} />
          </FormField>
          <div className="flex justify-end">
            <Link to="/forgot-password" className="text-xs text-ink-2 underline hover:text-ink">
              Forgot password?
            </Link>
          </div>
          <Button type="submit" loading={submitting} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-ink-2">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="text-gold hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default LoginPage;
