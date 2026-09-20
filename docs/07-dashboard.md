# 07 — Dashboard

Status: implementation-ready. Covers `apps/dashboard` (the user + admin web
app) and `packages/ui` (the design system it's built from). Read
[`01-architecture.md`](./01-architecture.md) for the system-level picture,
[`04-auth.md`](./04-auth.md) for the cookie/CSRF/2FA model this app
implements against, [`03-api.md`](./03-api.md) and
[`05-subscriptions.md`](./05-subscriptions.md) for the routes it calls, and
[`08-analytics.md`](./08-analytics.md) for the metric formulas behind the
analytics pages' charts.

## Contents

1. [Information architecture](#1-information-architecture)
2. [Routes and permissions matrix](#2-routes-and-permissions-matrix)
3. [Data flow](#3-data-flow)
4. [Auth, CSRF and WS handling](#4-auth-csrf-and-ws-handling)
5. [Auth/CSRF across origins (deployment)](#5-authcsrf-across-origins-deployment)
6. [Design tokens reference](#6-design-tokens-reference)
7. [Component inventory (`packages/ui`)](#7-component-inventory-packagesui)
8. [Testing](#8-testing)
9. [Deployment (Vercel)](#9-deployment-vercel)
10. [Accessibility notes](#10-accessibility-notes)
11. [Known API gaps](#11-known-api-gaps)

---

## 1. Information architecture

```
/login, /register, /verify-email, /forgot-password, /reset-password   (public)
/dashboard, /analytics, /subscriptions, /settings                     (any authenticated user)
/admin, /admin/users, /admin/profits, /admin/activity, /admin/system,
/admin/audit, /admin/subscriptions, /admin/coupons, /admin/plans,
/admin/flags, /admin/bans, /admin/feature-toggles, /admin/config       (role: admin)
/dev/components                                                        (dev build only)
```

One SPA, one shell (`src/routes/layouts.tsx`): a sidebar (user nav always;
an "Admin" section appended when `role === 'admin'`) + topbar (online
indicator, notifications bell, user email, sign out) wraps every
authenticated route. Public auth routes render inside a centered
`PublicLayout` instead. Every leaf route is code-split
(`lazyRouteComponent`), so the initial bundle only pays for the shell +
whichever page is active (see the `vite build` chunk list — each page under
`src/pages/**` is its own chunk).

## 2. Routes and permissions matrix

| Route | Guard | Notes |
|---|---|---|
| `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password` | none | Redirect target for a 401 anywhere (`?returnTo=`). |
| `/dashboard`, `/analytics`, `/subscriptions`, `/settings` | `appLayoutRoute.beforeLoad`: session bootstrapped and `status === 'authenticated'`, else redirect to `/login?returnTo=` | |
| `/admin/*` | `adminLayoutRoute.beforeLoad`: additionally `admin !== null` (i.e. `role === 'admin'`), else `notFound()` | Nav items under "Admin" are also only rendered when `admin !== null` — a non-admin never sees the links, and the route itself 404s if reached directly. **Fine-grained gating** by the four `AdminRole`s (`super_admin`/`support`/`analyst`/`billing`, `@sl/shared`'s `PERMISSION_MATRIX`) is not implemented client-side — see [§11](#11-known-api-gaps): the API doesn't expose the caller's own `adminRole` anywhere yet, so every admin currently sees every admin nav item and page; the server remains the real enforcement point (`fastify.requirePermission`) and a call a role doesn't grant surfaces as an inline 403 (toast/error state), never a silent failure. |
| `/dev/components` | `import.meta.env.DEV` only | Not reachable in a production build (`router.tsx` swaps its component for `NotFoundPage` when `DEV` is false). |

Admin pages and the endpoints/permissions they exercise (full detail in
`docs/03-api.md`/`docs/05-subscriptions.md`):

| Page | Endpoints | Permission(s) |
|---|---|---|
| `/admin` Overview | `GET /admin/analytics/overview`, WS `admin.overview.tick` | `analytics.read` |
| `/admin/users` | `GET/PATCH /admin/users`, `.../suspend`, `.../unsuspend`, `.../reset-password`, `.../force-logout`, `GET/POST /admin/bans`, `.../lift`, `GET /admin/flags`, `POST /admin/subscriptions/{userId}/activate`, `.../grant-lifetime` | `users.read`/`.write`/`.suspend`/`.reset_password`/`.force_logout` |
| `/admin/profits` | `GET /admin/analytics/profits`, `.../profits/leaderboard` | `analytics.read` |
| `/admin/activity` | `GET /admin/activity/{logins,searches,snipes,errors,devices,ips}` | `analytics.read` |
| `/admin/system` | `GET /admin/system/health` | `system.read` |
| `/admin/audit` | `GET /admin/audit` | `audit.read` |
| `/admin/subscriptions` | `GET /admin/analytics/subscriptions` | `analytics.read` |
| `/admin/coupons` | `GET/POST /admin/coupons`, `PATCH .../{id}` | `coupons.write` |
| `/admin/plans` | `GET/POST /admin/plans`, `PATCH/POST .../{id}(/archive)` | `plans.write` |
| `/admin/flags` | `GET /admin/flags`, `POST .../{id}/review` | `users.suspend`/`.ban` (flags share the moderation permission, `05-subscriptions.md` §8) |
| `/admin/bans` | `GET/POST /admin/bans`, `POST .../{id}/lift` | `users.suspend`/`.ban` |
| `/admin/feature-toggles` | `GET /admin/toggles`, `PATCH .../{key}` | `feature_toggles.write` |
| `/admin/config` | `GET /admin/config`, `PUT .../{key}` | `system.read` / `config.write` |

## 3. Data flow

- **Typed REST**: `src/api/client.ts` wraps `openapi-fetch`'s client over
  `src/api/schema.d.ts` (generated from `apps/api/openapi/openapi.json` via
  `pnpm --filter @sl/dashboard api:types` — commit the output after every
  API contract change). Every path is called with its full `/api/v1/...`
  key exactly as the generated `paths` type has it — see that file's header
  comment for why the client's base URL is the bare origin, not
  `${origin}/api/v1` (the `/api/v1` prefix is baked into every path key
  already, since the OpenAPI document doesn't strip it via a `servers`
  entry).
- **TanStack Query** owns all server-state caching; every page's `useQuery`/
  `useMutation` call sites live directly in that page's component (no
  separate "service" layer) — `queryKey`s are namespaced by resource
  (`['admin', 'users', ...]`, `['subscription']`, `['settings']`, …) so a
  mutation's `onSuccess` can invalidate precisely.
- **Zustand** (`src/stores/auth.ts`, `src/stores/adminLive.ts`) holds the
  two pieces of state components need synchronous, non-hook access to
  outside React's render cycle: the current session (read by
  `api/client.ts`'s 401 handler and the router's `beforeLoad` guards) and
  the live WS `admin.overview.tick` counters.
- **Forms**: react-hook-form + `@hookform/resolvers/zod`, resolving against
  `@sl/shared` Zod schemas directly wherever the request body schema is
  reusable as-is (`changePasswordRequestSchema`, `governorSettingsSchema`,
  `createCouponRequestSchema`, `planCreateRequestSchema`, …), or a thin
  local `.extend()`/`.refine()` on top (e.g. `RegisterPage`'s
  `registerFormSchema` adds a client-only `confirmPassword` check) — the
  API's own validation is never duplicated by hand, only composed with.
- **Analytics endpoints** (`/analytics/me/*`, `/admin/analytics/*`) use
  `@sl/shared`'s `schemas/analytics.ts` DTOs and go through the same typed
  `api` client as everything else (they landed in
  `apps/api/openapi/openapi.json` during this pass — 105 routes total).

## 4. Auth, CSRF and WS handling

- **Session bootstrap**: `src/lib/authBootstrap.ts#ensureBootstrapped()`
  calls `GET /users/me` once (cached as a module-level promise so React 19
  Strict Mode's double-invoke and the router's `beforeLoad` share one
  request) and populates `useAuthStore`. `resetBootstrap()` clears the cache
  after login/logout so the next guard re-fetches fresh.
- **CSRF**: `src/api/client.ts`'s `onRequest` middleware reads the
  non-httpOnly `sl_csrf` cookie and sets `x-csrf-token` on every
  `POST`/`PUT`/`PATCH`/`DELETE` (never on `GET`) — the exact double-submit
  contract `docs/04-auth.md` §10 describes. Covered by
  `test/apiClient.test.ts`.
- **401 handling**: the same client's `onResponse` middleware calls a
  handler registered by `router.tsx` (`setUnauthorizedHandler`) on any 401,
  which navigates to `/login?returnTo=<current path>` — except for the
  auth-exempt routes (`/auth/login`, `/auth/refresh`, `/auth/logout`,
  `/auth/mfa/verify`), which legitimately 401 as part of their own flow and
  must not trigger a redirect loop.
- **Login → MFA**: `LoginPage` posts credentials, and on `mfa_required`
  cannot know in advance whether the ticket is `'verify'` mode (normal
  step-up) or `'enroll'` mode (an admin's very first login ever — see
  `04-auth.md` §6). It optimistically calls `POST /auth/totp/enroll` with
  the ticket; a rejection ("This ticket is not an enrollment ticket") is
  read as "fall back to the plain verify-code form", not an error to show
  the user. The enroll path renders a QR code (`qrcode` package), the
  manual-entry secret (`CopyField`), and the ten recovery codes, then
  confirms via `POST /auth/totp/enroll/confirm`, which completes the
  pending login in the same response.
- **WebSocket** (`src/lib/ws.ts`, `src/hooks/useWsGateway.ts`): mounted once
  by the authenticated shell. `POST /ws/ticket` → connect to `/ws?ticket=`
  (unprefixed, per `docs/03-api.md` §ws) → reconnect with exponential
  backoff (1s → 30s cap) on close. Every `@sl/shared` `WsEvent` is handled:
  `session.revoked` clears the session and redirects to `/login`;
  `subscription.changed` invalidates the `['subscription']` query and
  toasts; `notification.new` invalidates `['notifications']` and toasts;
  `feature_toggles.changed`/`kill_switch` invalidate/toast for admins only;
  `admin.overview.tick` updates `useAdminLiveStore` for the Overview page's
  live counters.

## 5. Auth/CSRF across origins (deployment)

Two supported shapes, both documented in `apps/dashboard/.env.example`:

1. **Same-site dev proxy (default, recommended for local dev)**:
   `VITE_API_ORIGIN` unset → the dashboard makes relative `/api/v1/...`
   requests; `vite.config.ts`'s dev server proxies `/api`, `/health` and
   `/ws` to `DEV_API_PROXY_TARGET` (default `http://localhost:3000`). The
   browser only ever talks to `http://localhost:5173`, so `sl_at`/`sl_rt`/
   `sl_csrf` are ordinary same-site, first-party cookies — no
   `SameSite=None`/`Secure` wrinkle, and the API only needs
   `DASHBOARD_ORIGIN=http://localhost:5173` in its own CORS allowlist
   (`apps/api/.env.example`).
2. **Cross-site (Vercel production/preview)**: `VITE_API_ORIGIN` set to the
   deployed API's origin. The browser now talks to two origins, so the API
   must set its `sl_at`/`sl_rt`/`sl_csrf` cookies with `SameSite=None;
   Secure` (an API-side change, outside this app's ownership — flagged for
   the API/DevOps agents) and `DASHBOARD_ORIGIN` must equal the exact
   Vercel URL. A same-site reverse proxy in front of both (e.g. a Vercel
   rewrite or a shared apex domain with the API on a subdomain fronted by
   the same edge) avoids the `SameSite=None` requirement entirely and is
   the preferred production shape if available.

## 6. Design tokens reference

`packages/ui/src/tokens.css` is the single source; `apps/dashboard/src/styles/global.css`
maps it into Tailwind v4's `@theme`. Dark gaming theme, the only theme:

| Token | Value | Tailwind utility | Use |
|---|---|---|---|
| `--sl-ground` | `#0D1311` | `bg-ground` | Page background |
| `--sl-surface` | `#151D1A` | `bg-surface` | Card/sidebar background |
| `--sl-surface-2` | `#1B2522` | `bg-surface-2` | Raised surface (dropdown, input) |
| `--sl-line` | `#242F2B` | `border-line` | Borders/dividers |
| `--sl-ink` | `#E7EDEA` | `text-ink` | Primary text |
| `--sl-ink-2` | `#94A49E` | `text-ink-2` | Secondary/muted text |
| `--sl-gold` | `#DDB35C` | `bg-gold`/`text-gold` | Accent, primary buttons |
| `--sl-green` | `#6FBF9B` | `bg-live`/`text-live` | Positive/live status, chart series 1 |
| `--sl-red` | `#E08678` | `bg-risk`/`text-risk` | Negative/risk status, chart series 5 |
| `--sl-mid` | `#D6A94E` | `text-risk-mid` | Warning midpoint |
| `--sl-chart-{1..6}` | see tokens.css | `packages/ui/src/charts/palette.ts` | One categorical series palette across every chart (dataviz skill) |

Fonts: **Inter** (UI text) and **JetBrains Mono** (numbers, `tabular-nums`
applied globally to `.tabular-nums`/`input[type=number]`), loaded via Google
Fonts in `index.html`. Motion tokens (`--sl-motion-{fast,base,slow}`,
150/200/250ms) are zeroed under `prefers-reduced-motion: reduce`
(`tokens.css`), which also disables all CSS animation/transition duration
globally as a blanket fallback.

## 7. Component inventory (`packages/ui`)

Primitives (shadcn-style, Radix-backed where interaction/a11y is
non-trivial): `Button`, `IconButton`, `Input`, `PasswordInput`, `Select`,
`Switch`, `Checkbox`, `Textarea`, `FormField`, `Card` (+ Header/Title/
Description/Content/Footer), `StatTile`, `Badge`, `Tabs`, `DataTable`
(TanStack Table: sorting, column visibility, cursor pagination controls, row
actions, loading/empty/error states), `Modal`, `Drawer`, `Toast` (sonner),
`Tooltip`, `DropdownMenu`, `Skeleton`, `EmptyState`, `PageHeader`,
`Sidebar`, `KpiGrid`, `ChartCard` + `LineChart`/`AreaChart`/`BarChart`/
`DonutChart`/`Sparkline` (Recharts, one shared palette + `ChartTooltip`),
`DateRangePicker` (7d/30d/90d/custom presets), `DiffViewer` (audit log
before/after), `CopyField` (license keys, TOTP secrets). Formatters
(`lib/format.ts`): `formatCoins`, `formatCoinsCompact`, `formatPercent`,
`formatCurrencyFromCents`, `formatSignedPercent`, `formatDate`,
`formatDateTime`, `formatRelativeTime`.

`/dev/components` (dev-only route) renders every one of the above for
visual QA — the substitute for a full Storybook instance.

## 8. Testing

- **Unit/component** (`packages/ui/test/*.test.tsx`, `apps/dashboard/test/*.test.{ts,tsx}`,
  Vitest + Testing Library): `Button`, `StatTile`, `DiffViewer` in
  `packages/ui`; `authStore` (session transitions, including the
  known-permission-gap fallback — §11), `apiClient` (CSRF header
  attachment, 401 → unauthorized-handler wiring, auth-exempt paths), and
  `RegisterForm` (the real `registerFormSchema` exercised end-to-end through
  react-hook-form + the actual `@sl/ui` `FormField`/`Input` components, not
  a schema-only test) in `apps/dashboard`. `globals: false` in every
  `vitest.config.ts`, so each `test/setup.ts` explicitly wires
  `@testing-library/react`'s `cleanup()` into `afterEach` — Testing
  Library's own auto-cleanup only registers when it finds a global
  `afterEach`.
- **E2E** (`apps/dashboard/e2e/`, Playwright): `playwright.config.ts` runs
  against the **real** `apps/api` on the seeded dev Postgres/Redis (not a
  mock) via a `webServer` array — one entry starts the API with
  `tsx src/server.ts` directly (not `pnpm dev`/`tsx watch`, which restarts
  on any file change anywhere it's watching and was found during authoring
  to drop in-flight requests mid-test), one starts the dashboard's Vite dev
  server. `globalSetup.ts` connects to Postgres directly (the `postgres`
  package) and resets the seeded admin
  (`admin@sniperledger.local`/`Admin-Passw0rd!`) to a never-enrolled-2FA
  state and clears its devices/sessions before every run — this makes the
  suite exercise the TOTP **bootstrap** path (not just step-up verify)
  deterministically on every run, not only the first one, and avoids a
  false `DEVICE_LIMIT_REACHED` (this admin has no subscription, so its
  device limit falls back to the trial plan's, 1) from a prior run's
  leftover device row. `dashboard.spec.ts` is one continuous
  `test.step`-broken journey in a single browser context (deliberately —
  spreading across contexts would each register a competing device against
  that same 1-device limit): sign in → TOTP enrollment (the QR secret is
  read off the page and fed to `otplib`'s `authenticator.generate` — no
  secret is hardcoded) → confirm → `/admin` overview loads → `/admin/users`
  search → open a user, edit their timezone, save → `/admin/audit` shows
  the `user.updated` entry with the new value in its diff.

  **Chromium**: this environment's browser is pre-installed outside
  Playwright's own managed cache at `/opt/pw-browsers/chromium`
  (`playwright.config.ts`'s `launchOptions.executablePath`) — never run
  `pnpm exec playwright install`.

  **Running it**:
  ```bash
  # Postgres + Redis reachable at the URLs below, migrated + seeded with an
  # admin (packages/db/src/seed.ts, SEED_ADMIN_EMAIL=admin@sniperledger.local
  # SEED_ADMIN_PASSWORD='Admin-Passw0rd!' pnpm --filter @sl/db seed).
  cd apps/dashboard
  DATABASE_URL=postgres://sl:sl@127.0.0.1:5432/sniper_ledger \
  REDIS_URL=redis://127.0.0.1:6379 \
  xvfb-run -a pnpm exec playwright test
  ```
  This passed repeatably (three consecutive runs, including a rerun after a
  full process restart) during this pass. If the `webServer`-managed
  processes prove unreliable in a different environment, the two-terminal
  fallback is: terminal 1 —
  `DATABASE_URL=... REDIS_URL=... pnpm --filter @sl/api exec tsx src/server.ts`;
  terminal 2 — `pnpm --filter @sl/dashboard dev`; terminal 3 —
  `DATABASE_URL=... xvfb-run -a pnpm --filter @sl/dashboard exec playwright test`
  (globalSetup still needs `DATABASE_URL` to reset the seeded admin).

## 9. Deployment (Vercel)

`vercel.json` (repo root) already points `buildCommand` at
`pnpm --filter @sl/dashboard... build`, `outputDirectory` at
`apps/dashboard/dist`, and its `ignoreCommand` stopped skipping deploys the
moment `apps/dashboard/` existed. `pnpm --filter @sl/dashboard... build`
from a clean checkout: `tsc --noEmit -p tsconfig.json && vite build`,
verified in this pass. Set `VITE_API_ORIGIN` as a Vercel project environment
variable to the deployed API's origin (§5's cross-site shape) — leaving it
unset would make the deployed dashboard call its own Vercel origin as the
API, which doesn't exist there.

## 10. Accessibility notes

- Every icon-only control goes through `IconButton`, which mandates a
  `label` prop (rendered as both `aria-label` and `title`) — there is no
  icon-only button anywhere in `packages/ui` without an accessible name.
- Focus is visible everywhere via a global `:focus-visible` outline
  (`global.css`), keyboard-only so a mouse click stays quiet.
- Every form control is wired through `FormField`, which associates its
  `<label htmlFor>` with the control's `id` and renders validation errors
  with `role="alert"`.
- `Modal`/`Drawer`/`Select`/`DropdownMenu`/`Tabs`/`Tooltip`/`Switch`/
  `Checkbox` are Radix primitives underneath — focus trapping, roving
  tabindex, `aria-*` state and Escape-to-close come from Radix, not
  hand-rolled.
- `prefers-reduced-motion: reduce` zeroes every animation/transition
  duration globally (§6) — no component opts out individually.
- Layout is phone-width-first (360px minimum, per the design system) with
  no horizontal page scroll; the app shell's sidebar/topbar and every
  admin page's tables/grids use responsive Tailwind breakpoints
  (`sm:`/`lg:`) rather than a separate mobile layout.

## 11. Known API gaps

Found while building against the real, committed
`apps/api/openapi/openapi.json` — each is handled gracefully in the UI
(never a silent failure or a fabricated value) and called out in a code
comment at its call site:

1. **No endpoint exposes the caller's own admin permission set.**
   `GET /users/me` (`userDtoSchema`) carries only `role: 'user'|'admin'`,
   never the finer `admin_users.admin_role`/`PERMISSION_MATRIX` grant. The
   dashboard therefore gates every admin nav item/route on `role ===
   'admin'` alone (§2) rather than the four-role matrix the plan called
   for; `src/stores/auth.ts` documents this and defaults `admin.permissions`
   to the full set so today's UI stays usable, with every mutating call
   still enforced server-side. **Fix**: add the resolved `adminRole`/
   `permissions` to `GET /users/me`'s response schema, or a new
   `GET /admin/me`.
2. **No `GET /admin/subscriptions` list/lookup endpoint.** Only per-
   subscription action routes exist (`POST /admin/subscriptions/{id}/
   extend|suspend|unsuspend|cancel`, keyed by a subscription `id` the
   admin has no way to discover) plus two `{userId}`-keyed creators
   (`.../activate`, `.../grant-lifetime`). `/admin/subscriptions` (the
   page) therefore shows plan-mix/metrics analytics only, and the user
   detail drawer on `/admin/users` offers activate/grant-lifetime (the
   routes that work from a bare `userId`) with a visible note about the
   gap for extend/suspend/cancel. **Fix**: either return the user's live
   subscription (including its `id`) from `GET /admin/users/:id`, or add a
   list/lookup endpoint.
3. **`GET /admin/audit/export.csv` doesn't exist** (documented in
   `docs/03-api.md` but not in the committed OpenAPI spec). `/admin/audit`'s
   "Export CSV" button builds a CSV client-side from the currently
   loaded/filtered rows (`src/lib/csv.ts`) instead — correct for what's on
   screen, but not an unpaginated full-range server export.
4. **`admin-activity`'s `logins`/`searches`/`snipes`/`errors`/`ips`
   routes declare no Zod response schema** (confirmed against the
   generated `schema.d.ts`: `content?: never`), so `/admin/activity`'s
   five corresponding tabs render a best-effort generic row shape (time/
   device/IP + a JSON dump of the rest) instead of a strongly-typed table.
5. **No GET endpoint for `filter_stats`** (the ranker's realised-return
   history) — only the extension's ingest `POST /filters/stats`. The user
   Analytics page's "Filter performance" tab says so explicitly rather than
   showing empty/fabricated data.
6. **No GET endpoint for `risk_budget_events`** — only the extension's
   ingest `POST /risk-events`. The user Dashboard's "Risk posture" card
   shows the account's configured governor **budget** (`GET /settings`,
   which is real) instead of live risk-event history, which is the closest
   available real data to "risk posture".
