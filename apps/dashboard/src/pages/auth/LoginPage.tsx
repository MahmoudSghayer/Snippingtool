import { zodResolver } from '@hookform/resolvers/zod';
import { emailSchema } from '@sl/shared';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyField,
  FormField,
  Input,
  PasswordInput,
} from '@sl/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';
import { ensureBootstrapped, resetBootstrap } from '@/lib/authBootstrap.js';
import { buildDevicePayload, defaultDeviceName } from '@/lib/device.js';
import { postLoginPath } from '@/routes/access.js';
import { useAuthStore } from '@/stores/auth.js';

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

interface EnrollmentState {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
  qrDataUrl: string | null;
}

/** POST /auth/login -> tokens, or `mfa_required`. The ticket's mode
 * (`'verify'` vs `'enroll'`) is not exposed in the response
 * (docs/04-auth.md §6 "admin bootstrap") — an admin's very first login ever
 * gets an *enrollment* ticket instead of a normal step-up one, since they
 * have no TOTP secret yet to verify against. This page can't know which
 * mode it got in advance, so it optimistically calls `POST
 * /auth/totp/enroll` with the ticket first; the API rejects that call for a
 * `'verify'`-mode ticket ("This ticket is not an enrollment ticket"), which
 * this page reads as "fall back to the normal verify-code form" rather than
 * an error to show the user. */
export function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { returnTo?: string };
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detectingMode, setDetectingMode] = useState(false);

  const credentialsForm = useForm<CredentialsForm>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '', deviceName: defaultDeviceName() },
  });

  const mfaForm = useForm<MfaForm>({
    resolver: zodResolver(mfaSchema),
    defaultValues: { code: '' },
  });
  const enrollConfirmForm = useForm<MfaForm>({
    resolver: zodResolver(mfaSchema),
    defaultValues: { code: '' },
  });

  async function completeSession() {
    resetBootstrap();
    await ensureBootstrapped();
    // Admins land on the admin dashboard, customers on /account, unless
    // `returnTo` names the page they were on (routes/access.ts).
    await navigate({ to: postLoginPath(search.returnTo, useAuthStore.getState().admin) });
  }

  function resetMfaState() {
    setMfaTicket(null);
    setEnrollment(null);
  }

  async function onSubmitCredentials(values: CredentialsForm) {
    setSubmitting(true);
    try {
      const { data, error } = await api.POST('/api/v1/auth/login', {
        body: {
          email: values.email,
          password: values.password,
          device: buildDevicePayload(values.deviceName),
        },
      });
      if (error) {
        toast.error('Couldn’t sign in', { description: apiErrorMessage(error) });
        return;
      }
      if (data.status === 'ok') {
        toast.success('Welcome back');
        await completeSession();
        return;
      }

      // mfa_required — figure out enroll vs. verify (see the component doc
      // comment above).
      setMfaTicket(data.mfaTicket);
      setDetectingMode(true);
      const enrollAttempt = await api.POST('/api/v1/auth/totp/enroll', {
        body: { mfaTicket: data.mfaTicket },
      });
      setDetectingMode(false);
      if (!enrollAttempt.error) {
        const qrDataUrl = await QRCode.toDataURL(enrollAttempt.data.otpauthUrl).catch(() => null);
        setEnrollment({ ...enrollAttempt.data, qrDataUrl });
      }
      // On error, this ticket is a 'verify'-mode ticket — the plain
      // verify-code form below (rendered whenever `mfaTicket` is set and
      // `enrollment` isn't) is exactly the right next step already.
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitMfaVerify(values: MfaForm) {
    if (!mfaTicket) return;
    setSubmitting(true);
    try {
      const { error } = await api.POST('/api/v1/auth/mfa/verify', {
        body: { mfaTicket, code: values.code },
      });
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

  async function onSubmitEnrollConfirm(values: MfaForm) {
    if (!mfaTicket) return;
    setSubmitting(true);
    try {
      const { error } = await api.POST('/api/v1/auth/totp/enroll/confirm', {
        body: { mfaTicket, code: values.code },
      });
      if (error) {
        toast.error('Invalid code', { description: apiErrorMessage(error) });
        return;
      }
      toast.success('Two-factor authentication enabled — welcome!');
      await completeSession();
    } finally {
      setSubmitting(false);
    }
  }

  // While the enroll-vs-verify probe above is still in flight we do not yet
  // know which screen this is, so claim neither. Rendering the enrollment
  // heading here meant an already-enrolled admin saw a one-time-setup screen
  // flash on every single login, and left anything keying off that heading —
  // a screen reader, or the e2e helper — acting on a screen that was about to
  // be replaced by the verify form.
  if (mfaTicket && detectingMode) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Two-factor authentication</CardTitle>
          <p className="text-xs text-ink-2">Checking how this account signs in…</p>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-2">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  // Reached only once `enrollment` actually holds a secret, so the secret and
  // recovery codes below are always rendered alongside this heading.
  if (mfaTicket && enrollment) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Set up two-factor authentication</CardTitle>
          <p className="text-xs text-ink-2">
            Admin accounts require 2FA. This is a one-time setup for your first login.
          </p>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={enrollConfirmForm.handleSubmit(onSubmitEnrollConfirm)}
          >
            {enrollment.qrDataUrl && (
              <img
                src={enrollment.qrDataUrl}
                alt="Authenticator QR code"
                width={180}
                height={180}
                className="self-center rounded-md border border-line"
              />
            )}
            <CopyField label="Manual entry secret" value={enrollment.secret} />
            <div>
              <p className="mb-1 text-xs font-medium text-ink-2">
                Recovery codes (save these somewhere safe)
              </p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-ground p-3 font-mono text-xs">
                {enrollment.recoveryCodes.map((code) => (
                  <span key={code}>{code}</span>
                ))}
              </div>
            </div>
            <FormField
              label="Enter the 6-digit code to confirm"
              htmlFor="enroll-code"
              error={enrollConfirmForm.formState.errors.code?.message}
            >
              <Input
                id="enroll-code"
                autoFocus
                inputMode="numeric"
                {...enrollConfirmForm.register('code')}
              />
            </FormField>
            <Button type="submit" loading={submitting} className="w-full">
              Confirm and sign in
            </Button>
            <button
              type="button"
              className="text-xs text-ink-2 underline hover:text-ink"
              onClick={resetMfaState}
            >
              Use a different account
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  if (mfaTicket) {
    return (
      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <CardTitle>Two-factor verification</CardTitle>
          <p className="text-xs text-ink-2">
            Enter the 6-digit code from your authenticator app, or a recovery code.
          </p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={mfaForm.handleSubmit(onSubmitMfaVerify)}>
            <FormField
              label="Verification code"
              htmlFor="code"
              error={mfaForm.formState.errors.code?.message}
            >
              <Input
                id="code"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                {...mfaForm.register('code')}
              />
            </FormField>
            <Button type="submit" loading={submitting} className="w-full">
              Verify
            </Button>
            <button
              type="button"
              className="text-xs text-ink-2 underline hover:text-ink"
              onClick={resetMfaState}
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
        <p className="text-xs text-ink-2">
          Manage your pass, download the extension and see your devices.
        </p>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={credentialsForm.handleSubmit(onSubmitCredentials)}
        >
          <FormField
            label="Email"
            htmlFor="email"
            error={credentialsForm.formState.errors.email?.message}
          >
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              {...credentialsForm.register('email')}
            />
          </FormField>
          <FormField
            label="Password"
            htmlFor="password"
            error={credentialsForm.formState.errors.password?.message}
          >
            <PasswordInput
              id="password"
              autoComplete="current-password"
              {...credentialsForm.register('password')}
            />
          </FormField>
          <FormField
            label="This device"
            htmlFor="deviceName"
            hint="Listed under Devices in My account, so you can recognise and revoke it later."
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
          <Link
            to="/register"
            className="text-gold underline underline-offset-2 hover:text-gold/80"
          >
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default LoginPage;
