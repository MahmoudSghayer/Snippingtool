import { USER_STATUSES } from '@sl/shared';
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  formatDate,
  formatDateTime,
  FormField,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ColumnDef,
} from '@sl/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';


import { api, apiErrorMessage } from '@/api/client.js';
import { ReasonDialog } from '@/components/ReasonDialog.js';

import type { FlagDto, UserDto } from '@sl/shared';


const ANY = 'any';

const columns: ColumnDef<UserDto, unknown>[] = [
  { accessorKey: 'email', header: 'Email' },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (c) => {
      const v = c.getValue() as string;
      return <Badge tone={v === 'active' ? 'positive' : v === 'banned' ? 'negative' : 'warning'}>{v}</Badge>;
    },
  },
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'totpEnabled', header: '2FA', cell: (c) => (c.getValue() ? 'On' : 'Off') },
  { accessorKey: 'lastLoginAt', header: 'Last login', cell: (c) => (c.getValue() ? formatDate(c.getValue() as string) : 'Never') },
  { accessorKey: 'createdAt', header: 'Joined', cell: (c) => formatDate(c.getValue() as string) },
];

export function UsersPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(ANY);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<UserDto | null>(null);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', q, status, cursor],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/users', {
        params: { query: { q: q || undefined, status: status === ANY ? undefined : (status as never), cursor, limit: 50 } },
      });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">Users</h1>
          <p className="mt-1 text-sm text-ink-2">Search, moderate and manage subscriptions.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Search" htmlFor="q" className="w-64">
          <Input id="q" placeholder="Email contains…" value={q} onChange={(e) => { setQ(e.target.value); setCursor(undefined); setCursorStack([]); }} />
        </FormField>
        <FormField label="Status" htmlFor="status" className="w-44">
          <Select
            value={status}
            onValueChange={(v) => { setStatus(v); setCursor(undefined); setCursorStack([]); }}
            options={[{ value: ANY, label: 'Any status' }, ...USER_STATUSES.map((s) => ({ value: s, label: s }))]}
          />
        </FormField>
      </div>

      <DataTable
        columns={columns}
        data={usersQuery.data?.items ?? []}
        isLoading={usersQuery.isLoading}
        isError={usersQuery.isError}
        onRetry={() => void usersQuery.refetch()}
        emptyTitle="No users match these filters"
        getRowId={(row) => row.id}
        onRowClick={setSelected}
        hasNextPage={!!usersQuery.data?.nextCursor}
        hasPreviousPage={cursorStack.length > 0}
        onNextPage={() => {
          if (!usersQuery.data?.nextCursor) return;
          setCursorStack((s) => [...s, cursor ?? '']);
          setCursor(usersQuery.data.nextCursor);
        }}
        onPreviousPage={() => {
          setCursorStack((s) => {
            const next = [...s];
            const prev = next.pop();
            setCursor(prev || undefined);
            return next;
          });
        }}
      />

      {selected && (
        <UserDetailDrawer
          user={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })}
        />
      )}
    </div>
  );
}

function UserDetailDrawer({ user, onClose, onChanged }: { user: UserDto; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [timezone, setTimezone] = useState(user.timezone ?? '');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [lifetimeOpen, setLifetimeOpen] = useState(false);
  const [planCode, setPlanCode] = useState('pro');
  const [periodDays, setPeriodDays] = useState(30);

  const flagsQuery = useQuery({
    queryKey: ['admin', 'flags', 'user', user.id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/flags', { params: { query: { userId: user.id } } });
      if (error) throw error;
      return data.items as FlagDto[];
    },
  });

  const bansQuery = useQuery({
    queryKey: ['admin', 'bans', 'active'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/bans', { params: { query: { active: true } } });
      if (error) throw error;
      return data.items;
    },
  });
  const activeBan = bansQuery.data?.find((b) => b.userId === user.id && b.type === 'account');

  function invalidate() {
    onChanged();
    void queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] });
  }

  const updateProfileMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.PATCH('/api/v1/admin/users/{id}', { params: { path: { id: user.id } }, body: { timezone } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Profile updated');
      invalidate();
    },
    onError: (error) => toast.error("Couldn't save", { description: apiErrorMessage(error) }),
  });

  const suspendMutation = useMutation({
    mutationFn: async (reason: string) => {
      const path = user.status === 'suspended' ? '/api/v1/admin/users/{id}/unsuspend' : '/api/v1/admin/users/{id}/suspend';
      const { error } = await api.POST(path, { params: { path: { id: user.id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(user.status === 'suspended' ? 'User unsuspended' : 'User suspended');
      setSuspendOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('Action failed', { description: apiErrorMessage(error) }),
  });

  const banMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/bans', { body: { type: 'account', userId: user.id, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('User banned');
      setBanOpen(false);
      invalidate();
    },
    onError: (error) => toast.error("Couldn't ban user", { description: apiErrorMessage(error) }),
  });

  const unbanMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!activeBan) return;
      const { error } = await api.POST('/api/v1/admin/bans/{id}/lift', { params: { path: { id: activeBan.id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Ban lifted');
      invalidate();
    },
    onError: (error) => toast.error("Couldn't lift ban", { description: apiErrorMessage(error) }),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/users/{id}/reset-password', { params: { path: { id: user.id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Password reset email sent');
      setResetOpen(false);
    },
    onError: (error) => toast.error('Action failed', { description: apiErrorMessage(error) }),
  });

  const forceLogoutMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/users/{id}/force-logout', { params: { path: { id: user.id } }, body: { reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Every session revoked');
      setLogoutOpen(false);
    },
    onError: (error) => toast.error('Action failed', { description: apiErrorMessage(error) }),
  });

  const activateMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/subscriptions/{userId}/activate', {
        params: { path: { userId: user.id } },
        body: { planCode, periodDays, reason },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription activated');
      setActivateOpen(false);
    },
    onError: (error) => toast.error("Couldn't activate subscription", { description: apiErrorMessage(error) }),
  });

  const grantLifetimeMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.POST('/api/v1/admin/subscriptions/{userId}/grant-lifetime', { params: { path: { userId: user.id } }, body: { planCode, reason } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Lifetime access granted');
      setLifetimeOpen(false);
    },
    onError: (error) => toast.error("Couldn't grant lifetime", { description: apiErrorMessage(error) }),
  });

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()} title={user.email} description={`Joined ${formatDate(user.createdAt)}`} width="xl">
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="subscription">Subscription</TabsTrigger>
          <TabsTrigger value="flags">Flags {flagsQuery.data?.length ? `(${flagsQuery.data.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              <Badge tone={user.status === 'active' ? 'positive' : user.status === 'banned' ? 'negative' : 'warning'}>{user.status}</Badge>
              <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
              <Badge tone={user.totpEnabled ? 'positive' : 'neutral'}>{user.totpEnabled ? '2FA on' : '2FA off'}</Badge>
              {activeBan && <Badge tone="negative">Banned</Badge>}
            </div>

            <FormField label="Timezone" htmlFor="edit-timezone">
              <div className="flex gap-2">
                <Input id="edit-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                <Button size="sm" loading={updateProfileMutation.isPending} onClick={() => updateProfileMutation.mutate()}>
                  Save
                </Button>
              </div>
            </FormField>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setSuspendOpen(true)}>
                {user.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
              </Button>
              {activeBan ? (
                <Button size="sm" variant="outline" loading={unbanMutation.isPending} onClick={() => unbanMutation.mutate('Unbanned by admin')}>
                  Unban
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={() => setBanOpen(true)}>
                  Ban
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setResetOpen(true)}>
                Reset password
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLogoutOpen(true)}>
                Force logout
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="subscription">
          <div className="flex flex-col gap-4">
            <p className="text-xs text-ink-2">
              There is no endpoint to look up this user&apos;s current subscription by user id yet (docs/07-dashboard.md
              &quot;Known API gaps&quot;) — these actions create/extend entitlements directly.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Plan code" htmlFor="planCode">
                <Input id="planCode" value={planCode} onChange={(e) => setPlanCode(e.target.value)} />
              </FormField>
              <FormField label="Period (days)" htmlFor="periodDays">
                <Input id="periodDays" type="number" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} />
              </FormField>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setActivateOpen(true)}>
                Activate subscription
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLifetimeOpen(true)}>
                Grant lifetime
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="flags">
          <div className="flex flex-col gap-2">
            {flagsQuery.isLoading && <p className="text-sm text-ink-2">Loading…</p>}
            {!flagsQuery.isLoading && flagsQuery.data?.length === 0 && <p className="text-sm text-ink-2">No flags for this user.</p>}
            {flagsQuery.data?.map((flag) => (
              <div key={flag.id} className="rounded-md border border-line p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">{flag.kind}</span>
                  <Badge tone={flag.severity === 'low' ? 'neutral' : flag.severity === 'medium' ? 'warning' : 'negative'}>{flag.severity}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-2">{formatDateTime(flag.createdAt)} · {flag.status}</p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <ReasonDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={user.status === 'suspended' ? 'Unsuspend user' : 'Suspend user'}
        destructive={user.status !== 'suspended'}
        loading={suspendMutation.isPending}
        onConfirm={(reason) => suspendMutation.mutate(reason)}
      />
      <ReasonDialog open={banOpen} onOpenChange={setBanOpen} title="Ban user" destructive confirmLabel="Ban" loading={banMutation.isPending} onConfirm={(reason) => banMutation.mutate(reason)} />
      <ReasonDialog open={resetOpen} onOpenChange={setResetOpen} title="Send password reset" loading={resetPasswordMutation.isPending} onConfirm={(reason) => resetPasswordMutation.mutate(reason)} />
      <ReasonDialog open={logoutOpen} onOpenChange={setLogoutOpen} title="Force logout" destructive confirmLabel="Force logout" loading={forceLogoutMutation.isPending} onConfirm={(reason) => forceLogoutMutation.mutate(reason)} />
      <ReasonDialog open={activateOpen} onOpenChange={setActivateOpen} title={`Activate ${planCode} for ${periodDays}d`} confirmLabel="Activate" loading={activateMutation.isPending} onConfirm={(reason) => activateMutation.mutate(reason)} />
      <ReasonDialog open={lifetimeOpen} onOpenChange={setLifetimeOpen} title={`Grant lifetime (${planCode})`} confirmLabel="Grant lifetime" loading={grantLifetimeMutation.isPending} onConfirm={(reason) => grantLifetimeMutation.mutate(reason)} />
    </Drawer>
  );
}

export default UsersPage;
