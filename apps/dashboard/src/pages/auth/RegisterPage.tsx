import { zodResolver } from '@hookform/resolvers/zod';
import { registerRequestSchema } from '@sl/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, PasswordInput } from '@sl/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';
import { buildDevicePayload, defaultDeviceName } from '@/lib/device.js';

// Exported so test/RegisterForm.test.tsx can validate it directly without
// needing a router context to render the whole page.
export const registerFormSchema = registerRequestSchema
  .omit({ device: true })
  .extend({ deviceName: z.string().min(1).max(120), confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });
type FormValues = z.infer<typeof registerFormSchema>;

export function RegisterPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: '', password: '', confirmPassword: '', deviceName: defaultDeviceName() },
  });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      const { error } = await api.POST('/api/v1/auth/register', {
        body: {
          email: values.email,
          password: values.password,
          device: buildDevicePayload(values.deviceName),
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
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
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
          <FormField label="Confirm password" htmlFor="confirmPassword" error={form.formState.errors.confirmPassword?.message}>
            <PasswordInput id="confirmPassword" autoComplete="new-password" {...form.register('confirmPassword')} />
          </FormField>
          <FormField label="This device" htmlFor="deviceName" error={form.formState.errors.deviceName?.message}>
            <Input id="deviceName" {...form.register('deviceName')} />
          </FormField>
          <Button type="submit" loading={submitting} className="w-full">
            Create account
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-ink-2">
          Already have an account?{' '}
          <Link to="/login" className="text-gold hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default RegisterPage;
