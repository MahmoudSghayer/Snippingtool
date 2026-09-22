// Cmd/Ctrl+K command palette wiring: routes + (admins) user-by-email search
// -> @sl/ui's presentational CommandPalette. Mounted once by AppLayout; the
// keyboard shortcut is global while the authenticated shell is mounted
// (docs/07-dashboard.md "Command palette", PHASE 10).
import { CommandPalette as UiCommandPalette, type CommandPaletteItem } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  BarChart3,
  Ban,
  CreditCard,
  Crosshair,
  FileClock,
  Flag,
  Gauge,
  Gift,
  LayoutDashboard,
  Search,
  Server,
  Settings as SettingsIcon,
  Sliders,
  Ticket,
  Users as UsersIcon,
  Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/api/client.js';

interface PaletteRoute {
  key: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  keywords?: string;
  adminOnly?: boolean;
}

const ROUTES: PaletteRoute[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    icon: <LayoutDashboard className="size-4" />,
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
  {
    key: 'admin-overview',
    label: 'Admin · Overview',
    href: '/admin',
    icon: <Gauge className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-users',
    label: 'Admin · Users',
    href: '/admin/users',
    icon: <UsersIcon className="size-4" />,
    adminOnly: true,
    keywords: 'search find',
  },
  {
    key: 'admin-profits',
    label: 'Admin · Profits',
    href: '/admin/profits',
    icon: <BarChart3 className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-activity',
    label: 'Admin · Activity',
    href: '/admin/activity',
    icon: <Gauge className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-system',
    label: 'Admin · System',
    href: '/admin/system',
    icon: <Server className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-audit',
    label: 'Admin · Audit log',
    href: '/admin/audit',
    icon: <FileClock className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-subscriptions',
    label: 'Admin · Subscriptions',
    href: '/admin/subscriptions',
    icon: <CreditCard className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-coupons',
    label: 'Admin · Coupons',
    href: '/admin/coupons',
    icon: <Ticket className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-plans',
    label: 'Admin · Plans',
    href: '/admin/plans',
    icon: <Gift className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-flags',
    label: 'Admin · Flags',
    href: '/admin/flags',
    icon: <Flag className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-bans',
    label: 'Admin · Bans',
    href: '/admin/bans',
    icon: <Ban className="size-4" />,
    adminOnly: true,
  },
  {
    key: 'admin-toggles',
    label: 'Admin · Feature toggles',
    href: '/admin/feature-toggles',
    icon: <Sliders className="size-4" />,
    adminOnly: true,
  },
];

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}

export function CommandPalette({ open, onOpenChange, isAdmin }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const isEmailLike = query.trim().length >= 2;

  const userSearchQuery = useQuery({
    queryKey: ['command-palette', 'users', query],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/users', {
        params: { query: { q: query, limit: 5 } },
      });
      if (error) throw error;
      return data;
    },
    enabled: open && isAdmin && isEmailLike,
    staleTime: 10_000,
  });

  const matchedRoutes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ROUTES.filter((r) => !r.adminOnly || isAdmin).filter(
      (r) => !q || r.label.toLowerCase().includes(q) || r.keywords?.includes(q),
    );
  }, [query, isAdmin]);

  const userResults = isAdmin ? (userSearchQuery.data?.items ?? []) : [];

  const items: CommandPaletteItem[] = useMemo(() => {
    const routeItems: CommandPaletteItem[] = matchedRoutes.map((r) => ({
      key: r.key,
      label: r.label,
      icon: r.icon,
      onSelect: () => void navigate({ to: r.href }),
    }));
    const userItems: CommandPaletteItem[] = userResults.map((u) => ({
      key: `user-${u.id}`,
      label: u.email,
      sub: `${u.status} · ${u.role}`,
      icon: <Search className="size-4" />,
      onSelect: () => void navigate({ to: '/admin/users', search: { q: u.email } }),
    }));
    return [...routeItems, ...userItems];
  }, [matchedRoutes, userResults, navigate]);

  return (
    <UiCommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      placeholder={isAdmin ? 'Go to a page, or search users by email…' : 'Go to a page…'}
      description={`Jump to a page${isAdmin ? ', or search for a user by email' : ''}.`}
      items={items}
      emptyMessage={isAdmin && userSearchQuery.isFetching ? 'Searching…' : 'No matches.'}
    />
  );
}

/** Global Cmd/Ctrl+K listener — call once from the authenticated shell. */
export function useCommandPaletteShortcut(onOpenChange: (open: boolean) => void): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(true);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpenChange]);
}
