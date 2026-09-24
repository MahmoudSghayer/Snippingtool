// "Account and security" on /account: sign-in email, password, two-factor
// authentication and account deletion.
import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordRequestSchema } from '@sl/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyField,
  FormField,
  Input,
  Modal,
  PasswordInput,
} from '@sl/ui';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';
import { ensureBootstrapped, resetBootstrap } from '@/lib/authBootstrap.js';
import { useAuthStore } from '@/stores/auth.js';

type PasswordForm = z.infer<typeof changePasswordRequestSchema>;
const deleteAccountSchema = z.object({ password: z.string().min(1, 'Enter your password') });
type DeleteAccountForm = z.infer<typeof deleteAccountSchema>;
interface DisableTwoFactorForm {
  currentPassword: string;
  code: string;
}

/** Re-reads /users/me so the store (and `user.totpEnabled`) matches the
 * server after a security change. */
async function refreshSession(): Promise<void> {
  resetBootstrap();
  await ensureBootstrapped();
}

export function EmailCard() {
  const email = useAuthStore((s) => s.user?.email ?? '');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
      </CardHeader>
      <CardContent>
        <FormField label="Signed in as" htmlFor="account-email">
          <Input id="account-email" value={email} readOnly disabled />
        </FormField>
      </CardContent>
    </Card>
  );
}

export function ChangePasswordCard() {
  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(changePasswordRequestSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const passwordMutation = useMutation({
    mutationFn: async (values: PasswordForm) => {
      const { error } = await api.POST('/api/v1/auth/password/change', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Password changed. Please sign in again.');
      passwordForm.reset();
    },
    onError: (error) =>
      toast.error("Couldn't change your password", { description: apiErrorMessage(error) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex max-w-sm flex-col gap-4"
          onSubmit={passwordForm.handleSubmit((v) => passwordMutation.mutate(v))}
        >
          <FormField
            label="Current password"
            htmlFor="currentPassword"
            error={passwordForm.formState.errors.currentPassword?.message}
          >
            <PasswordInput
              id="currentPassword"
              autoComplete="current-password"
              {...passwordForm.register('currentPassword')}
            />
          </FormField>
          <FormField
            label="New password"
            htmlFor="newPassword"
            error={passwordForm.formState.errors.newPassword?.message}
          >
            <PasswordInput
              id="newPassword"
              autoComplete="new-password"
              {...passwordForm.register('newPassword')}
            />
          </FormField>
          <Button type="submit" size="sm" className="w-fit" loading={passwordMutation.isPending}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function downloadRecoveryCodes(codes: readonly string[]): void {
  const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nova-trade-recovery-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}

export function TwoFactorCard() {
  const totpEnabled = useAuthStore((s) => s.user?.totpEnabled ?? false);
  const [enrolling, setEnrolling] = useState(false);
  const [secret, setSecret] = useState<{
    secret: string;
    otpauthUrl: string;
    recoveryCodes: string[];
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);

  const disableForm = useForm<DisableTwoFactorForm>({
    defaultValues: { currentPassword: '', code: '' },
  });

  useEffect(() => {
    if (!secret) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(secret.otpauthUrl).then(setQrDataUrl);
  }, [secret]);

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/auth/totp/enroll', { body: {} });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => setSecret(data),
    onError: (error) =>
      toast.error("Couldn't start 2FA setup", { description: apiErrorMessage(error) }),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/auth/totp/enroll/confirm', { body: { code } });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success('Two-factor authentication is on');
      setEnrolling(false);
      setSecret(null);
      setCode('');
      await refreshSession();
    },
    onError: (error) => toast.error('Invalid code', { description: apiErrorMessage(error) }),
  });

  const disableMutation = useMutation({
    mutationFn: async (values: DisableTwoFactorForm) => {
      const { error } = await api.POST('/api/v1/auth/totp/disable', { body: values });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success('Two-factor authentication is off');
      setDisableOpen(false);
      disableForm.reset();
      await refreshSession();
    },
    onError: (error) =>
      toast.error("Couldn't turn off 2FA", { description: apiErrorMessage(error) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <Badge tone={totpEnabled ? 'positive' : 'neutral'}>{totpEnabled ? 'On' : 'Off'}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          Asks for a code from an authenticator app when you sign in, so a leaked password alone
          can't open your account.
        </p>
        {totpEnabled ? (
          <Button
            variant="destructive"
            size="sm"
            className="w-fit"
            onClick={() => setDisableOpen(true)}
          >
            Turn off 2FA
          </Button>
        ) : !enrolling ? (
          <Button size="sm" className="w-fit" onClick={() => setEnrolling(true)}>
            Turn on 2FA
          </Button>
        ) : !secret ? (
          <Button
            size="sm"
            className="w-fit"
            loading={enrollMutation.isPending}
            onClick={() => enrollMutation.mutate()}
          >
            Start setup
          </Button>
        ) : (
          <>
            {qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="Authenticator QR code"
                width={180}
                height={180}
                className="rounded-md border border-line"
              />
            )}
            <CopyField label="Manual entry secret" value={secret.secret} />
            <div>
              <p className="mb-1 text-xs font-medium text-ink-2">
                Recovery codes (save these somewhere safe, they're shown once)
              </p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-ground p-3 font-mono text-xs">
                {secret.recoveryCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => downloadRecoveryCodes(secret.recoveryCodes)}
              >
                Download codes
              </Button>
            </div>
            <FormField label="Enter the 6-digit code to confirm" htmlFor="mfaCode">
              <Input
                id="mfaCode"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </FormField>
            <Button
              size="sm"
              className="w-fit"
              loading={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate()}
            >
              Confirm and turn on
            </Button>
          </>
        )}
      </CardContent>

      <Modal
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Turn off two-factor authentication"
        footer={
          <>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={disableMutation.isPending}
              onClick={disableForm.handleSubmit((v) => disableMutation.mutate(v))}
            >
              Turn off
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4">
          <FormField label="Current password" htmlFor="disable-password">
            <PasswordInput id="disable-password" {...disableForm.register('currentPassword')} />
          </FormField>
          <FormField label="Current code (authenticator or recovery)" htmlFor="disable-code">
            <Input id="disable-code" {...disableForm.register('code')} />
          </FormField>
        </form>
      </Modal>
    </Card>
  );
}

export function DeleteAccountCard() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const deleteForm = useForm<DeleteAccountForm>({
    resolver: zodResolver(deleteAccountSchema),
    defaultValues: { password: '' },
  });

  // Account deletion: the one handler. Anything that must happen after an
  // account is deleted belongs in this onSuccess.
  const deleteMutation = useMutation({
    mutationFn: async (values: DeleteAccountForm) => {
      const { error } = await api.DELETE('/api/v1/users/me', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      useAuthStore.getState().clearSession();
      resetBootstrap();
      void navigate({ to: '/login' });
    },
    onError: (error) =>
      toast.error("Couldn't delete your account", { description: apiErrorMessage(error) }),
  });

  return (
    <Card className="border-risk/40">
      <CardHeader>
        <CardTitle className="text-risk">Delete account</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-ink-2">
          Deleting your account is permanent. It signs out every device and ends any pass you have.
        </p>
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Delete account
        </Button>
      </CardContent>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Delete your account"
        description="This cannot be undone."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={deleteForm.handleSubmit((v) => deleteMutation.mutate(v))}
            >
              Delete my account
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4">
          <FormField
            label="Confirm your password"
            htmlFor="delete-password"
            error={deleteForm.formState.errors.password?.message}
          >
            <PasswordInput id="delete-password" {...deleteForm.register('password')} />
          </FormField>
        </form>
      </Modal>
    </Card>
  );
}
