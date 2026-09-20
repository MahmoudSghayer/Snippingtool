// Code-based TanStack Router tree (PHASE 7: "your call" on file-based vs
// code-based — code-based chosen for explicit control over the guard
// structure below without an extra route-tree-generation build step).
// Every leaf route's component is lazy-loaded (`lazyRouteComponent`) for
// route-level code splitting per PHASE 7's shell requirements.
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';

import { setUnauthorizedHandler } from '@/api/client.js';
import { ensureBootstrapped } from '@/lib/authBootstrap.js';
import { ErrorPage } from '@/pages/ErrorPage.js';
import { NotFoundPage } from '@/pages/NotFoundPage.js';
import { AppLayout, PublicLayout, RootLayout } from '@/routes/layouts.js';
import { useAuthStore } from '@/stores/auth.js';

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

// --- Public (unauthenticated) ----------------------------------------------

const publicLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public',
  component: PublicLayout,
});

const loginSearchSchema = z.object({ returnTo: z.string().optional() });

const loginRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/login',
  validateSearch: loginSearchSchema,
  component: lazyRouteComponent(() => import('@/pages/auth/LoginPage.js'), 'LoginPage'),
});

const registerRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/register',
  component: lazyRouteComponent(() => import('@/pages/auth/RegisterPage.js'), 'RegisterPage'),
});

const verifyEmailSearchSchema = z.object({ token: z.string().optional() });

const verifyEmailRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/verify-email',
  validateSearch: verifyEmailSearchSchema,
  component: lazyRouteComponent(() => import('@/pages/auth/VerifyEmailPage.js'), 'VerifyEmailPage'),
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(() => import('@/pages/auth/ForgotPasswordPage.js'), 'ForgotPasswordPage'),
});

const resetPasswordSearchSchema = z.object({ token: z.string().optional() });

const resetPasswordRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/reset-password',
  validateSearch: resetPasswordSearchSchema,
  component: lazyRouteComponent(() => import('@/pages/auth/ResetPasswordPage.js'), 'ResetPasswordPage'),
});

// --- Authenticated shell -----------------------------------------------------

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppLayout,
  beforeLoad: async ({ location }) => {
    await ensureBootstrapped();
    if (useAuthStore.getState().status !== 'authenticated') {
      throw redirect({ to: '/login', search: { returnTo: location.href } });
    }
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/dashboard',
  component: lazyRouteComponent(() => import('@/pages/user/DashboardPage.js'), 'DashboardPage'),
});

const analyticsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/analytics',
  component: lazyRouteComponent(() => import('@/pages/user/AnalyticsPage.js'), 'AnalyticsPage'),
});

const subscriptionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/subscriptions',
  component: lazyRouteComponent(() => import('@/pages/user/SubscriptionsPage.js'), 'SubscriptionsPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/pages/user/SettingsPage.js'), 'SettingsPage'),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/dashboard" />,
});

// --- Admin (nested under the app shell, additionally role-guarded) ---------

const adminLayoutRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  id: 'admin',
  path: '/admin',
  beforeLoad: () => {
    if (useAuthStore.getState().admin === null) {
      throw notFound();
    }
  },
});

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/pages/admin/OverviewPage.js'), 'OverviewPage'),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/users',
  component: lazyRouteComponent(() => import('@/pages/admin/UsersPage.js'), 'UsersPage'),
});

const adminProfitsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/profits',
  component: lazyRouteComponent(() => import('@/pages/admin/ProfitsPage.js'), 'ProfitsPage'),
});

const adminActivityRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/activity',
  component: lazyRouteComponent(() => import('@/pages/admin/ActivityPage.js'), 'ActivityPage'),
});

const adminSystemRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/system',
  component: lazyRouteComponent(() => import('@/pages/admin/SystemPage.js'), 'SystemPage'),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/audit',
  component: lazyRouteComponent(() => import('@/pages/admin/AuditPage.js'), 'AuditPage'),
});

const adminSubscriptionsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/subscriptions',
  component: lazyRouteComponent(() => import('@/pages/admin/SubscriptionsAdminPage.js'), 'SubscriptionsAdminPage'),
});

const adminCouponsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/coupons',
  component: lazyRouteComponent(() => import('@/pages/admin/CouponsPage.js'), 'CouponsPage'),
});

const adminPlansRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/plans',
  component: lazyRouteComponent(() => import('@/pages/admin/PlansPage.js'), 'PlansPage'),
});

const adminFlagsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/flags',
  component: lazyRouteComponent(() => import('@/pages/admin/FlagsPage.js'), 'FlagsPage'),
});

const adminBansRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/bans',
  component: lazyRouteComponent(() => import('@/pages/admin/BansPage.js'), 'BansPage'),
});

const adminFeatureTogglesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/feature-toggles',
  component: lazyRouteComponent(() => import('@/pages/admin/FeatureTogglesPage.js'), 'FeatureTogglesPage'),
});

const adminConfigRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/config',
  component: lazyRouteComponent(() => import('@/pages/admin/ConfigPage.js'), 'ConfigPage'),
});

// --- Dev-only component gallery ---------------------------------------------

const devComponentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/components',
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import('@/pages/dev/ComponentsPage.js'), 'ComponentsPage')
    : NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  publicLayoutRoute.addChildren([loginRoute, registerRoute, verifyEmailRoute, forgotPasswordRoute, resetPasswordRoute]),
  appLayoutRoute.addChildren([
    dashboardRoute,
    analyticsRoute,
    subscriptionsRoute,
    settingsRoute,
    adminLayoutRoute.addChildren([
      adminOverviewRoute,
      adminUsersRoute,
      adminProfitsRoute,
      adminActivityRoute,
      adminSystemRoute,
      adminAuditRoute,
      adminSubscriptionsRoute,
      adminCouponsRoute,
      adminPlansRoute,
      adminFlagsRoute,
      adminBansRoute,
      adminFeatureTogglesRoute,
      adminConfigRoute,
    ]),
  ]),
  devComponentsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultNotFoundComponent: NotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// 401 anywhere -> send the browser to /login, preserving the path it was on
// so a successful login can return there (docs/07-dashboard.md "401 ->
// redirect to login preserving return path").
setUnauthorizedHandler((path) => {
  if (window.location.pathname === '/login') return;
  void router.navigate({ to: '/login', search: { returnTo: path } });
});
