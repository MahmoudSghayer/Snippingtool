// Who goes where. The web app has two audiences:
//   - customers: a small account area (/account) inside the website's
//     header and footer (routes/SiteLayout.tsx);
//   - admins: the sidebar dashboard under /admin/* (routes/layouts.tsx).
// Every redirect decision (after login, the retired customer routes, the
// bare `/` route, the 404 page's "back" link) goes through the helpers
// below so the two audiences can't drift apart.
import { redirect } from '@tanstack/react-router';

import { permissionsFor, type AdminNavKey } from '@/lib/adminNav.js';
import { ensureBootstrapped } from '@/lib/authBootstrap.js';
import { useAuthStore, type AdminSessionInfo } from '@/stores/auth.js';

export const ACCOUNT_PATH = '/account';
export const ADMIN_PATH = '/admin';

/** Customer routes from before the split. Each one now redirects to the
 * caller's home (`homePathFor`), so old bookmarks and links keep working. */
export const RETIRED_CUSTOMER_PATHS = [
  '/dashboard',
  '/trades',
  '/bot',
  '/analytics',
  '/subscriptions',
  '/settings',
] as const;

/** Admin pages in sidebar order, for picking the first one an admin can
 * open when their role doesn't grant the overview (analytics.read). */
const ADMIN_LANDING_ORDER: [AdminNavKey, string][] = [
  ['admin-overview', '/admin'],
  ['admin-users', '/admin/users'],
  ['admin-subscriptions', '/admin/subscriptions'],
  ['admin-payments', '/admin/payments'],
  ['admin-system', '/admin/system'],
  ['admin-audit', '/admin/audit'],
  ['admin-coupons', '/admin/coupons'],
  ['admin-plans', '/admin/plans'],
  ['admin-flags', '/admin/flags'],
  ['admin-toggles', '/admin/feature-toggles'],
  ['admin-config', '/admin/config'],
];

/** Where a signed-in user belongs: admins to the admin dashboard (the first
 * page their permissions open), everyone else to /account. */
export function homePathFor(admin: AdminSessionInfo | null): string {
  if (!admin) return ACCOUNT_PATH;
  const granted = ADMIN_LANDING_ORDER.find(([key]) =>
    permissionsFor(key).some((p) => admin.permissions.includes(p)),
  );
  return granted?.[1] ?? ADMIN_PATH;
}

function isAdminPath(path: string): boolean {
  return /^\/admin(?:[/?#]|$)/.test(path);
}

/** Where to go after a successful sign-in. A `returnTo` search param wins
 * when it is a same-origin path (never `//host`, never back to /login) and,
 * for a non-admin, not an admin page; otherwise the caller's home. */
export function postLoginPath(
  returnTo: string | undefined,
  admin: AdminSessionInfo | null,
): string {
  const home = homePathFor(admin);
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return home;
  if (returnTo === '/login' || returnTo.startsWith('/login?')) return home;
  if (!admin && isAdminPath(returnTo)) return home;
  return returnTo;
}

/** `beforeLoad` guard: loads the session once, and sends anyone signed out
 * to /login with a way back here. */
export async function requireSignedIn(location: { href: string }): Promise<void> {
  await ensureBootstrapped();
  if (useAuthStore.getState().status !== 'authenticated') {
    throw redirect({ to: '/login', search: { returnTo: location.href } });
  }
}

/** `beforeLoad` for `/` and the retired customer routes: signed-out users go
 * to /login, everyone else to their home. Always throws a redirect. */
export async function redirectToHome(): Promise<never> {
  await ensureBootstrapped();
  const state = useAuthStore.getState();
  if (state.status !== 'authenticated') {
    throw redirect({ to: '/login', search: {} });
  }
  throw redirect({ to: homePathFor(state.admin) });
}
