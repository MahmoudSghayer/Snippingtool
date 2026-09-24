import { zodResolver } from '@hookform/resolvers/zod';
import { registerRequestSchema } from '@sl/shared';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  FormField,
  Input,
  PasswordInput,
} from '@sl/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';
import { buildDevicePayload, defaultDeviceName } from '@/lib/device.js';

export const ACCEPT_TERMS_ERROR =
  'Accept the Terms of Service and Refund Policy to create an account.';

// Exported so test/RegisterForm.test.tsx can validate it directly without
// needing a router context to render the whole page. `acceptTerms` is a
// boolean here (the checkbox starts unticked) that must be `true` to pass;
// the request itself always sends the literal `true` the API requires.
export const registerFormSchema = registerRequestSchema
  .omit({ device: true, acceptTerms: true })
  .extend({
    deviceName: z.string().min(1).max(120),
    confirmPassword: z.string(),
    acceptTerms: z.boolean().refine((v) => v, { message: ACCEPT_TERMS_ERROR }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type RegisterFormValues = z.infer<typeof registerFormSchema>;

export interface RegisterFormProps {
  onSubmit: (values: RegisterFormValues) => void | Promise<void>;
  submitting?: boolean;
  defaultDeviceName?: string;
}

/** The register form on its own (no router, no API), so the tests render
 * exactly what the page renders. */
export function RegisterForm({
  onSubmit,
  submitting,
  defaultDeviceName: device,
}: RegisterFormProps) {
  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: {
      email: '',
      password: '',
      confirmPassword: '',
      deviceName: device ?? '',
      acceptTerms: false,
    },
  });
  const termsError = form.formState.errors.acceptTerms?.message;

  return (
    <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" autoFocus {...form.register('email')} />
      </FormField>
      <FormField
        label="Password"
        htmlFor="password"
        hint="At least 12 characters, with a letter and a digit."
        error={form.formState.errors.password?.message}
      >
        <PasswordInput id="password" autoComplete="new-password" {...form.register('password')} />
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
      <FormField
        label="This device"
        htmlFor="deviceName"
        error={form.formState.errors.deviceName?.message}
      >
        <Input id="deviceName" {...form.register('deviceName')} />
      </FormField>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2.5">
          <Controller
            control={form.control}
            name="acceptTerms"
            render={({ field }) => (
              <Checkbox
                id="acceptTerms"
                className="mt-0.5 shrink-0"
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked === true)}
                aria-required
                aria-invalid={termsError ? true : undefined}
                aria-describedby={termsError ? 'acceptTerms-error' : 'acceptTerms-note'}
              />
            )}
          />
          <label htmlFor="acceptTerms" className="text-sm text-ink">
            I accept the{' '}
            <a
              href="/terms"
              target="_blank"
              rel="noopener"
              className="text-gold underline underline-offset-2 hover:text-gold/80"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="/refund-policy"
              target="_blank"
              rel="noopener"
              className="text-gold underline underline-offset-2 hover:text-gold/80"
            >
              Refund Policy
            </a>
          </label>
        </div>
        <p id="acceptTerms-note" className="pl-7.5 text-xs text-ink-2">
          Bans are your own risk and are never refundable.
        </p>
        {termsError && (
          <p id="acceptTerms-error" role="alert" className="pl-7.5 text-xs text-risk">
            {termsError}
          </p>
        )}
      </div>

      <Button type="submit" loading={submitting} className="w-full">
        Create account
      </Button>
    </form>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(values: RegisterFormValues) {
    setSubmitting(true);
    try {
      const { error } = await api.POST('/api/v1/auth/register', {
        body: {
          email: values.email,
          password: values.password,
          device: buildDevicePayload(values.deviceName),
          acceptTerms: true,
        },
      });
      if (error) {
        toast.error('Couldn’t create your account', { description: apiErrorMessage(error) });
        return;
      }
      await navigate({ to: '/verify-email' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>Create your account</CardTitle>
        <p className="text-xs text-ink-2">Start with a 7-day trial, no card required.</p>
      </CardHeader>
      <CardContent>
        <RegisterForm
          onSubmit={onSubmit}
          submitting={submitting}
          defaultDeviceName={defaultDeviceName()}
        />
        <p className="mt-5 text-center text-sm text-ink-2">
          Already have an account?{' '}
          <Link to="/login" className="text-gold underline underline-offset-2 hover:text-gold/80">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default RegisterPage;
