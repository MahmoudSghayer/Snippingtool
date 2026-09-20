import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordRequestSchema, governorSettingsSchema, GOVERNOR_ABSOLUTE_LIMITS } from '@sl/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyField,
  DataTable,
  FormField,
  Input,
  Modal,
  PageHeader,
  PasswordInput,
  Switch,
  formatDate,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';


import { api, apiErrorMessage } from '@/api/client.js';
import { resetBootstrap } from '@/lib/authBootstrap.js';
import { useAuthStore } from '@/stores/auth.js';

// `@sl/shared` has no dedicated `sessionDtoSchema` export today (the
// `sessions` module's DTO lives only in the OpenAPI spec) — this local shape
// matches `GET /sessions`'s response exactly, kept here rather than adding a
// speculative schema to the additive-only `packages/shared` surface for a
// shape only this one page consumes.
interface SessionRow {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

const profileSchema = z.object({ timezone: z.string().min(1).max(64) });
type ProfileForm = z.infer<typeof profileSchema>;
type PasswordForm = z.infer<typeof changePasswordRequestSchema>;
type GovernorForm = z.infer<typeof governorSettingsSchema>;
const deleteAccountSchema = z.object({ password: z.string().min(1) });
type DeleteAccountForm = z.infer<typeof deleteAccountSchema>;

const sessionColumns: ColumnDef<SessionRow, unknown>[] = [
  {
    accessorKey: 'userAgent',
    header: 'Device / browser',
    cell: (c) => (
      <div className="flex items-center gap-2">
        <span>{(c.getValue() as string | null) ?? 'Unknown'}</span>
        {c.row.original.isCurrent && <Badge tone="accent">This session</Badge>}
      </div>
    ),
  },
  { accessorKey: 'ip', header: 'IP', cell: (c) => (c.getValue() as string | null) ?? '—' },
  { accessorKey: 'lastUsedAt', header: 'Last used', cell: (c) => formatDate(c.getValue() as string) },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [mfaEnrolling, setMfaEnrolling] = useState(false);
  const [mfaSecret, setMfaSecret] = useState<{ secret: string; otpauthUrl: string; recoveryCodes: string[] } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings');
      if (error) throw error;
      return data;
    },
  });

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/sessions');
      if (error) throw error;
      return data as SessionRow[];
    },
  });

  const profileForm = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    values: user ? { timezone: user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined,
  });

  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(changePasswordRequestSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const governorForm = useForm<GovernorForm>({
    resolver: zodResolver(governorSettingsSchema),
    values: settingsQuery.data?.governor,
  });

  const disableForm = useForm<{ currentPassword: string; code: string }>({
    defaultValues: { currentPassword: '', code: '' },
  });

  const deleteForm = useForm<DeleteAccountForm>({ resolver: zodResolver(deleteAccountSchema), defaultValues: { password: '' } });

  useEffect(() => {
    if (!mfaSecret) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(mfaSecret.otpauthUrl).then(setQrDataUrl);
  }, [mfaSecret]);

  const profileMutation = useMutation({
    mutationFn: async (values: ProfileForm) => {
      const { error } = await api.PATCH('/api/v1/users/me', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Profile updated');
      resetBootstrap();
    },
    onError: (error) => toast.error("Couldn't save", { description: apiErrorMessage(error) }),
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
    onError: (error) => toast.error("Couldn't change password", { description: apiErrorMessage(error) }),
  });

  const governorMutation = useMutation({
    mutationFn: async (values: GovernorForm) => {
      const { error } = await api.PUT('/api/v1/settings', { body: { governor: values } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Governor budget updated');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => toast.error("Couldn't save", { description: apiErrorMessage(error) }),
  });

  async function toggleSetting(patch: Record<string, unknown>) {
    const { error } = await api.PUT('/api/v1/settings', { body: patch });
    if (error) {
      toast.error("Couldn't save", { description: apiErrorMessage(error) });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  }

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/auth/totp/enroll', { body: {} });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => setMfaSecret(data),
    onError: (error) => toast.error("Couldn't start 2FA enrolment", { description: apiErrorMessage(error) }),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/auth/totp/enroll/confirm', { body: { code: mfaCode } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Two-factor authentication enabled');
      setMfaEnrolling(false);
      setMfaSecret(null);
      setMfaCode('');
      resetBootstrap();
    },
    onError: (error) => toast.error('Invalid code', { description: apiErrorMessage(error) }),
  });

  const disableMutation = useMutation({
    mutationFn: async (values: { currentPassword: string; code: string }) => {
      const { error } = await api.POST('/api/v1/auth/totp/disable', { body: values });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Two-factor authentication disabled');
      setDisableOpen(false);
      resetBootstrap();
    },
    onError: (error) => toast.error("Couldn't disable 2FA", { description: apiErrorMessage(error) }),
  });

  const revokeSessionMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/sessions/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Session revoked');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => toast.error("Couldn't revoke session", { description: apiErrorMessage(error) }),
  });

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
    onError: (error) => toast.error("Couldn't delete account", { description: apiErrorMessage(error) }),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Profile, security, budgets and account." />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex max-w-sm flex-col gap-4" onSubmit={profileForm.handleSubmit((v) => profileMutation.mutate(v))}>
            <FormField label="Email" htmlFor="email-ro">
              <Input id="email-ro" value={user?.email ?? ''} disabled />
            </FormField>
            <FormField label="Timezone" htmlFor="timezone" error={profileForm.formState.errors.timezone?.message}>
              <Input id="timezone" {...profileForm.register('timezone')} />
            </FormField>
            <Button type="submit" size="sm" className="w-fit" loading={profileMutation.isPending}>
              Save profile
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex max-w-sm flex-col gap-4" onSubmit={passwordForm.handleSubmit((v) => passwordMutation.mutate(v))}>
            <FormField label="Current password" htmlFor="currentPassword" error={passwordForm.formState.errors.currentPassword?.message}>
              <PasswordInput id="currentPassword" autoComplete="current-password" {...passwordForm.register('currentPassword')} />
            </FormField>
            <FormField label="New password" htmlFor="newPassword" error={passwordForm.formState.errors.newPassword?.message}>
              <PasswordInput id="newPassword" autoComplete="new-password" {...passwordForm.register('newPassword')} />
            </FormField>
            <Button type="submit" size="sm" className="w-fit" loading={passwordMutation.isPending}>
              Change password
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <Badge tone={user?.totpEnabled ? 'positive' : 'neutral'}>{user?.totpEnabled ? 'Enabled' : 'Disabled'}</Badge>
        </CardHeader>
        <CardContent>
          {user?.totpEnabled ? (
            <Button variant="destructive" size="sm" onClick={() => setDisableOpen(true)}>
              Disable 2FA
            </Button>
          ) : mfaEnrolling ? (
            <div className="flex flex-col gap-4">
              {!mfaSecret ? (
                <Button size="sm" className="w-fit" loading={enrollMutation.isPending} onClick={() => enrollMutation.mutate()}>
                  Start enrolment
                </Button>
              ) : (
                <>
                  {qrDataUrl && <img src={qrDataUrl} alt="Authenticator QR code" width={180} height={180} className="rounded-md border border-line" />}
                  <CopyField label="Manual entry secret" value={mfaSecret.secret} />
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-2">Recovery codes (save these somewhere safe — shown once)</p>
                    <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-ground p-3 font-mono text-xs">
                      {mfaSecret.recoveryCodes.map((code) => (
                        <span key={code}>{code}</span>
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1"
                      onClick={() => {
                        const blob = new Blob([mfaSecret.recoveryCodes.join('\n')], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'sniper-ledger-recovery-codes.txt';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download codes
                    </Button>
                  </div>
                  <FormField label="Enter the 6-digit code to confirm" htmlFor="mfaCode">
                    <Input id="mfaCode" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} inputMode="numeric" />
                  </FormField>
                  <Button size="sm" className="w-fit" loading={confirmMutation.isPending} onClick={() => confirmMutation.mutate()}>
                    Confirm and enable
                  </Button>
                </>
              )}
            </div>
          ) : (
            <Button size="sm" onClick={() => setMfaEnrolling(true)}>
              Enable 2FA
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Governor budgets</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={governorForm.handleSubmit((v) => governorMutation.mutate(v))}>
            <FormField label="Actions / hour" htmlFor="actionsPerHour">
              <Input
                id="actionsPerHour"
                type="number"
                min={GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.min}
                max={GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max}
                {...governorForm.register('actionsPerHour', { valueAsNumber: true })}
              />
            </FormField>
            <FormField label="Session length (min)" htmlFor="sessionLengthMinutes">
              <Input
                id="sessionLengthMinutes"
                type="number"
                min={GOVERNOR_ABSOLUTE_LIMITS.sessionLengthMinutes.min}
                max={GOVERNOR_ABSOLUTE_LIMITS.sessionLengthMinutes.max}
                {...governorForm.register('sessionLengthMinutes', { valueAsNumber: true })}
              />
            </FormField>
            <FormField label="Buy:search ratio" htmlFor="buyToSearchRatio">
              <Input
                id="buyToSearchRatio"
                type="number"
                step="0.01"
                min={GOVERNOR_ABSOLUTE_LIMITS.buyToSearchRatio.min}
                max={GOVERNOR_ABSOLUTE_LIMITS.buyToSearchRatio.max}
                {...governorForm.register('buyToSearchRatio', { valueAsNumber: true })}
              />
            </FormField>
            <FormField label="Cooldown (sec)" htmlFor="cooldownSeconds">
              <Input
                id="cooldownSeconds"
                type="number"
                min={GOVERNOR_ABSOLUTE_LIMITS.cooldownSeconds.min}
                max={GOVERNOR_ABSOLUTE_LIMITS.cooldownSeconds.max}
                {...governorForm.register('cooldownSeconds', { valueAsNumber: true })}
              />
            </FormField>
            <FormField label="Max coin flow / hour" htmlFor="maxCoinFlowPerHour" className="sm:col-span-2">
              <Input
                id="maxCoinFlowPerHour"
                type="number"
                min={GOVERNOR_ABSOLUTE_LIMITS.maxCoinFlowPerHour.min}
                max={GOVERNOR_ABSOLUTE_LIMITS.maxCoinFlowPerHour.max}
                {...governorForm.register('maxCoinFlowPerHour', { valueAsNumber: true })}
              />
            </FormField>
            <Button type="submit" size="sm" className="w-fit sm:col-span-2" loading={governorMutation.isPending}>
              Save budgets
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telemetry & notifications</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-ink">Telemetry opt-out</p>
              <p className="text-xs text-ink-2">Stop sending account-agnostic product telemetry (search metadata, errors, version). Never affects the kill switch.</p>
            </div>
            <Switch checked={settingsQuery.data?.telemetryOptOut ?? false} onCheckedChange={(v) => void toggleSetting({ telemetryOptOut: v })} aria-label="Telemetry opt-out" />
          </div>
          {settingsQuery.data &&
            (Object.keys(settingsQuery.data.notifications) as (keyof typeof settingsQuery.data.notifications)[]).map((key) => (
              <div key={key} className="flex items-center justify-between">
                <p className="text-sm text-ink capitalize">{key.replace(/([A-Z])/g, ' $1')}</p>
                <Switch
                  checked={settingsQuery.data!.notifications[key]}
                  onCheckedChange={(v) => void toggleSetting({ notifications: { [key]: v } })}
                  aria-label={key}
                />
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={sessionsQuery.data ?? []}
            isLoading={sessionsQuery.isLoading}
            isError={sessionsQuery.isError}
            onRetry={() => void sessionsQuery.refetch()}
            emptyTitle="No active sessions"
            getRowId={(row) => row.id}
            rowActions={(row) =>
              !row.isCurrent && (
                <Button size="sm" variant="outline" loading={revokeSessionMutation.isPending} onClick={() => revokeSessionMutation.mutate(row.id)}>
                  Revoke
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Card className="border-risk/40">
        <CardHeader>
          <CardTitle className="text-risk">Danger zone</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-ink-2">Deleting your account is permanent and ends every active session and subscription.</p>
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            Delete account
          </Button>
        </CardContent>
      </Card>

      <Modal
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Disable two-factor authentication"
        footer={
          <>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={disableMutation.isPending} onClick={disableForm.handleSubmit((v) => disableMutation.mutate(v))}>
              Disable
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4">
          <FormField label="Current password" htmlFor="disable-password">
            <PasswordInput id="disable-password" {...disableForm.register('currentPassword')} />
          </FormField>
          <FormField label="Current code (TOTP or recovery)" htmlFor="disable-code">
            <Input id="disable-code" {...disableForm.register('code')} />
          </FormField>
        </form>
      </Modal>

      <Modal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete your account"
        description="This cannot be undone."
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={deleteMutation.isPending} onClick={deleteForm.handleSubmit((v) => deleteMutation.mutate(v))}>
              Delete my account
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4">
          <FormField label="Confirm your password" htmlFor="delete-password" error={deleteForm.formState.errors.password?.message}>
            <PasswordInput id="delete-password" {...deleteForm.register('password')} />
          </FormField>
        </form>
      </Modal>
    </div>
  );
}

export default SettingsPage;
