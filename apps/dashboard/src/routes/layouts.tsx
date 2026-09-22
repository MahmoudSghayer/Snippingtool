import { Badge, Drawer, Sidebar, Toaster } from '@sl/ui';
import { Link, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeftRight,
  AlertTriangle,
  BarChart3,
  Bell,
  Ban,
  CreditCard,
  Crosshair,
  FileClock,
  Flag,
  Gauge,
  Gift,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Server,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  Ticket,
  Users as UsersIcon,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@/api/client.js';
import { CommandPalette, useCommandPaletteShortcut } from '@/components/CommandPalette.js';
import { NotificationsBell } from '@/components/NotificationsBell.js';
import { useWsGateway } from '@/hooks/useWsGateway.js';
import { ADMIN_NAV_PERMISSIONS, type AdminNavKey } from '@/lib/adminNav.js';
import { resetBootstrap } from '@/lib/authBootstrap.js';
import { useAuthStore } from '@/stores/auth.js';
import { useConnectionStore } from '@/stores/connection.js';

/** Wraps every route (public and authenticated): toaster + notFound live
 * here once instead of per-layout. */
export function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

/** Centered card shell for /login, /register, /forgot-password, etc. */
export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-ground px-4 py-10">
      <div className="flex items-center gap-2 text-ink">
        <Shield className="size-6 text-gold" aria-hidden="true" />
        <span className="font-mono text-lg font-semibold tracking-tight">The Sniper's Ledger</span>
      </div>
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </div>
  );
}

const NO_PERMISSIONS: readonly string[] = [];

const userNav = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    icon: <LayoutDashboard className="size-4" />,
  },
  {
    key: 'trades',
    label: 'Trades',
    href: '/trades',
    icon: <ArrowLeftRight className="size-4" />,
  },
  {
    key: 'bot',
    label: 'Bot',
    href: '/bot',
    icon: <Crosshair className="size-4" />,
  },
  {
    key: 'analytics',
    label: 'Analytics',
    href: '/analytics',
    icon: <BarChart3 className="size-4" />,
  },
  {
    key: 'subscriptions',
    label: 'Subscription',
    href: '/subscriptions',
    icon: <Wallet className="size-4" />,
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: <SettingsIcon className="size-4" />,
  },
];

const adminNav = [
  { key: 'admin-overview', label: 'Overview', href: '/admin', icon: <Gauge className="size-4" /> },
  {
    key: 'admin-users',
    label: 'Users',
    href: '/admin/users',
    icon: <UsersIcon className="size-4" />,
  },
  {
    key: 'admin-profits',
    label: 'Profits',
    href: '/admin/profits',
    icon: <BarChart3 className="size-4" />,
  },
  {
    key: 'admin-activity',
    label: 'Activity',
    href: '/admin/activity',
    icon: <Activity className="size-4" />,
  },
  {
    key: 'admin-system',
    label: 'System',
    href: '/admin/system',
    icon: <Server className="size-4" />,
  },
  {
    key: 'admin-audit',
    label: 'Audit log',
    href: '/admin/audit',
    icon: <FileClock className="size-4" />,
  },
  {
    key: 'admin-subscriptions',
    label: 'Subscriptions',
    href: '/admin/subscriptions',
    icon: <CreditCard className="size-4" />,
  },
  {
    key: 'admin-coupons',
    label: 'Coupons',
    href: '/admin/coupons',
    icon: <Ticket className="size-4" />,
  },
  { key: 'admin-plans', label: 'Plans', href: '/admin/plans', icon: <Gift className="size-4" /> },
  { key: 'admin-flags', label: 'Flags', href: '/admin/flags', icon: <Flag className="size-4" /> },
  { key: 'admin-bans', label: 'Bans', href: '/admin/bans', icon: <Ban className="size-4" /> },
  {
    key: 'admin-toggles',
    label: 'Feature toggles',
    href: '/admin/feature-toggles',
    icon: <Sliders className="size-4" />,
  },
  {
    key: 'admin-config',
    label: 'Config',
    href: '/admin/config',
    icon: <AlertTriangle className="size-4" />,
  },
];

/** Authenticated shell: sidebar + topbar. Mounted by every `/dashboard`,
 * `/analytics`, `/subscriptions`, `/settings` and `/admin/*` route
 * (docs/07-dashboard.md "Shell"). */
export function AppLayout() {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isAdmin = useAuthStore((s) => s.admin !== null);
  // Select the store's own array (or null) and default outside the
  // selector: a `?? []` inside it hands zustand's useSyncExternalStore a
  // fresh array on every call for a non-admin user, which React treats as
  // a changed snapshot and re-renders until it throws "Maximum update
  // depth exceeded" — every regular (non-admin) account hit that on its
  // first page after login, while the admin-only e2e suite never did.
  const adminPermissionsOrNull = useAuthStore((s) => s.admin?.permissions ?? null);
  const adminPermissions = adminPermissionsOrNull ?? NO_PERMISSIONS;
  const connectionStatus = useConnectionStore((s) => s.status);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useWsGateway();
  useCommandPaletteShortcut(setPaletteOpen);

  useEffect(() => {
    if (!user) return;
    // Registers activity-agnostic presence — the WS hook alone keeps the
    // socket open, this effect just guarantees the app shell only mounts
    // once a session is known (see AuthGuard below for the actual guard).
  }, [user]);

  async function handleLogout() {
    await api.POST('/api/v1/auth/logout', { body: { allDevices: false } });
    resetBootstrap();
    useAuthStore.getState().clearSession();
    void navigate({ to: '/login' });
  }

  // A nav item is shown only when the caller's real permission set grants
  // at least one of the permissions its page needs (docs/07-dashboard.md §2,
  // lib/adminNav.ts) — real per-role gating, not `isAdmin` alone.
  const visibleAdminNav = adminNav.filter((item) =>
    ADMIN_NAV_PERMISSIONS[item.key as AdminNavKey].some((p) => adminPermissions.includes(p)),
  );

  const sections = [
    {
      items: userNav.map((item) => ({
        ...item,
        active: !!matchRoute({ to: item.href, fuzzy: item.href !== '/dashboard' }),
      })),
    },
    ...(isAdmin && visibleAdminNav.length > 0
      ? [
          {
            title: 'Admin',
            items: visibleAdminNav.map((item) => ({
              ...item,
              active: !!matchRoute({ to: item.href, fuzzy: item.href !== '/admin' }),
            })),
          },
        ]
      : []),
  ];

  const brand = (
    <Link to="/dashboard" className="flex items-center gap-2 font-mono text-sm font-semibold">
      <Shield className="size-5 text-gold" aria-hidden="true" />
      Sniper's Ledger
    </Link>
  );

  const signOutFooter = (
    <button
      type="button"
      onClick={handleLogout}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <LogOut className="size-4" aria-hidden="true" />
      Sign out
    </button>
  );

  const connectionLabel =
    connectionStatus === 'open'
      ? 'Online'
      : connectionStatus === 'connecting'
        ? 'Connecting…'
        : 'Offline';
  const connectionDotClass =
    connectionStatus === 'open'
      ? 'bg-live'
      : connectionStatus === 'connecting'
        ? 'bg-gold animate-pulse'
        : 'bg-risk';

  return (
    <div className="flex h-dvh overflow-hidden bg-ground text-ink">
      {/* Desktop sidebar — hidden below `lg`, replaced by the off-canvas
          Drawer below (docs/10-design-system.md "Responsive: sidebar ->
          drawer at 360–390px/768px"). */}
      <Sidebar
        className="hidden lg:flex"
        brand={brand}
        sections={sections}
        linkComponent={({ href, className, children, ...rest }) => (
          <Link to={href} className={className} {...rest}>
            {children}
          </Link>
        )}
        footer={signOutFooter}
      />

      {/* Mobile/tablet off-canvas nav — same content, opened by the topbar's
          hamburger button, closed on a link tap. */}
      <Drawer open={navOpen} onOpenChange={setNavOpen} side="left" width="nav">
        <Sidebar
          className="h-full w-full border-r-0"
          brand={brand}
          sections={sections}
          linkComponent={({ href, className, children, ...rest }) => (
            <Link to={href} className={className} onClick={() => setNavOpen(false)} {...rest}>
              {children}
            </Link>
          )}
          footer={signOutFooter}
        />
      </Drawer>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={isAdmin} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              className="rounded-(--sl-radius-sm) p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-ground lg:hidden"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            <div className="hidden items-center gap-2 sm:flex">
              <span
                className={`inline-flex size-2 rounded-full ${connectionDotClass}`}
                aria-hidden="true"
              />
              <span className="text-xs text-ink-2">{connectionLabel}</span>
            </div>
            {isAdmin && (
              <Badge tone="accent" className="hidden sm:inline-flex">
                Admin
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden items-center gap-2 rounded-(--sl-radius-sm) border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-ground sm:flex"
            >
              <Search className="size-3.5" aria-hidden="true" />
              Search
              <kbd className="ml-1 rounded border border-line px-1 font-mono text-[10px]">⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="rounded-(--sl-radius-sm) p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-ground sm:hidden"
            >
              <Search className="size-4" aria-hidden="true" />
            </button>
            <NotificationsBell />
            <span className="hidden text-sm text-ink-2 md:inline">{user?.email}</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AdminOnlyGate({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.admin !== null);
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <Bell className="size-6 text-ink-2" aria-hidden="true" />
        <p className="text-sm font-medium text-ink">Admins only</p>
        <p className="text-sm text-ink-2">Your account doesn't have access to this area.</p>
      </div>
    );
  }
  return <>{children}</>;
}
