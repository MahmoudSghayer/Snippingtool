# The Sniper's Ledger

A commercial-grade SaaS companion for EA FC Ultimate Team transfer-market
sniping, built on a private, per-user record of what the market actually did
— not a crowd-sourced guess. It ships in three milestones:

- **M1 — Ledger (done).** A read-only MV3 extension that passively records
  market listings into local IndexedDB and shows floor / median / sell-through
  / max-snipe in an in-page panel. No automation.
- **M2 — Assist (built, awaiting live-market verification).** Human-in-the-loop
  opportunity ranking, filter rotation by realised coins/hour, session P&L and
  a visible risk-budget meter, backed by accounts, subscriptions and a
  dashboard.
- **M3 — Automation (built, gated).** An autobuyer that only ever acts through
  the safety governor, shipped as a **separate extension build** from the
  listable one.

Two rules hold across every milestone: the extension only ever **drives the
game's own service layer**, never forges a request; and the **safety
governor** sits between every decision and every action so the product stops
you before you look like a bot — it is never sold as "undetectable". See
[`docs/01-architecture.md`](docs/01-architecture.md) for how that is enforced.

## Build status

The build follows a data-first sequence. All eleven phases are built and
verified on this branch (`pnpm typecheck && pnpm lint && pnpm build && pnpm
test`: 683 tests across seven packages). Remaining work is the go-live
checklist in `docs/13-roadmap.md`, which needs the live market, real Stripe
keys and infrastructure.

| Phase | Scope | Status | Where |
| --- | --- | --- | --- |
| 1 Architecture | Monorepo, shared contracts, diagrams, roadmap | Done | `packages/shared`, `docs/01-architecture.md`, `docs/13-roadmap.md` |
| 2 Database | 35 tables, partitioning, audit, views, seed, tests | Done | `packages/db`, `docs/02-database.md` |
| 3 Backend API | Fastify, 110+ routes, WS gateway, jobs, OpenAPI | Done | `apps/api`, `docs/03-api.md` |
| 4 Authentication | JWT + rotating refresh, sessions, devices, 2FA, lockout, admin roles | Done | `apps/api/src/modules/auth`, `docs/04-auth.md` |
| 5 Subscriptions | Plans, trials with abuse protection, licenses, Stripe, coupons, bans, flags | Done | `apps/api/src/modules/{subscriptions,licenses,payments,coupons,plans,bans,flags}`, `docs/05-subscriptions.md` |
| 6 Extension | TypeScript port, ranker, governor, assist, gated autobuyer, popup, options | Done | `apps/extension`, `docs/06-extension.md` |
| 7 Dashboard | React user + admin dashboard, design system, e2e against the real API | Done | `apps/dashboard`, `packages/ui`, `docs/07-dashboard.md` |
| 8 Analytics | KPI engine, profit analytics, reports, CSV exports, materialisation jobs | Done | `apps/api/src/modules/{analytics,admin-analytics}`, `docs/08-analytics.md` |
| 9 Security | Hardening pass, 167 security tests, threat model, controls inventory | Done | `docs/09-security.md`, `docs/threat-model.md` |
| 10 UI/UX | Design system, dashboard and extension surfaces, axe-checked | Done | `packages/ui`, `docs/10-design-system.md` |
| 11 Testing | Unit, integration, cross-app e2e, k6 load, security suites, coverage | Done | `tests/`, `docs/12-testing.md` |
| DevOps | Docker, Compose, Caddy, CI/CD, monitoring, backups, deploy guides | Done | `infra/`, `.github/`, `docs/11-devops.md` |

Follow-ups from every phase report and all nine QA defects have been closed
(see `docs/12-testing.md` §12 for the defect table with statuses). One open
item remains: the cross-app e2e journey for extension telemetry fails on a
mock-fixture timing race in the multi-page harness; the single-app extension
e2e covering the same path passes.

## What exists today

**Extension** (`apps/extension`): two build targets from one codebase.
`ledger` is the listable build (recorder + assist); `ledger-auto` adds the
autobuyer, which is excluded from the `ledger` bundle at build time. The
only EA-aware file is `src/main/adapter.ts`; it observes passively, probes the
web app's service layer at load and before every action, and hard-stops on a
shape mismatch. The governor enforces actions per hour, session length,
buy-to-search ratio and coin flow, with cooldowns and an unconditional server
kill switch. Raw observations stay in IndexedDB. What the extension sends to
the backend is itemised in `docs/06-extension.md` and in the options page.

**Backend** (`apps/api`): Fastify 5 with Zod validation and generated OpenAPI,
Drizzle over PostgreSQL 16, Redis-backed rate limits and presence, a
WebSocket gateway with Redis pub/sub fan-out, BullMQ workers, Stripe billing,
and an audit log with before/after on every admin action.

**Database** (`packages/db`): hand-written SQL migrations with monthly
partitioning for activity and audit tables, append-only audit logs, soft
deletes everywhere, KPI views and a materialised daily KPI table.

**Dashboard** (`apps/dashboard` + `packages/ui`): React 19 user and admin
dashboard on the generated OpenAPI client, cookie sessions with CSRF, live
counters and notifications over WebSocket, and a component library in the
dark gaming theme. Deployed to Vercel.

**Shared contracts** (`packages/shared`): plan and feature constants, error
codes, the admin permission matrix, every request and response schema, the
WebSocket event union and the extension message contracts.

## Layout

```
apps/
  api/          Fastify backend: REST, WebSocket, BullMQ workers
  dashboard/    React user + admin dashboard (Vite, TanStack, Tailwind)
  extension/    MV3 extension, two build targets
packages/
  shared/       Zod schemas, DTOs, error codes, plans, permissions, message contracts
  db/           SQL migrations, Drizzle schema, seed, test utilities
  config/       Shared tsconfig / ESLint / Prettier presets
  ui/           Design system: tokens and React components
infra/          Docker, Compose, Caddy, monitoring, backups
docs/           One document per phase; start at docs/01-architecture.md
```

## Quick start

Requirements: Node 22, pnpm via Corepack, PostgreSQL 16 and Redis 7.

```bash
corepack enable
pnpm install

# database (defaults: postgres://sl:sl@127.0.0.1:5432/sniper_ledger)
pnpm --filter @sl/db migrate
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='change-me' pnpm --filter @sl/db seed

# API (copy apps/api/.env.example to apps/api/.env first)
pnpm --filter @sl/api keys:generate      # JWT + entitlement signing keys
pnpm --filter @sl/api dev                # http://localhost:3000, /health/ready
pnpm --filter @sl/api worker             # BullMQ jobs

# extension
pnpm --filter @sl/extension build        # dist/ledger and dist/ledger-auto
# chrome://extensions → Developer mode → Load unpacked → apps/extension/dist/ledger

# everything (test suites run serially: they share the test database)
pnpm typecheck && pnpm lint && pnpm build && pnpm test
pnpm test:e2e && pnpm test:security && pnpm test:load   # see docs/12-testing.md
```

API, db and security tests need `DATABASE_URL`, `TEST_DATABASE_URL`,
`REDIS_URL` and `REDIS_TEST_DB`; see `apps/api/.env.example` and
`docs/12-testing.md` for per-suite isolation.

## Deployment

The dashboard deploys to Vercel from `apps/dashboard` (see `vercel.json`);
set `VITE_API_ORIGIN` in the Vercel project and `DASHBOARD_ORIGIN` on the
API, see `docs/07-dashboard.md`. The API,
worker, PostgreSQL and Redis run on a VM with Docker Compose behind Caddy.
Images, Compose files for dev/staging/prod, monitoring, backups, CI/CD and
the step-by-step deployment guide live under `infra/`, `.github/` and
`docs/11-devops.md`.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/01-architecture.md` | Components, deployment, sequence diagrams, trust boundaries, build targets |
| `docs/02-database.md` | ERD, every table, indexes, partitioning and retention runbooks |
| `docs/03-api.md` | Every route with auth, permission, rate limit and schema |
| `docs/04-auth.md` | Token lifetimes, refresh rotation, devices, 2FA, CSRF, admin roles |
| `docs/05-subscriptions.md` | Plan matrix, state machine, license keys, trial protection, Stripe webhooks |
| `docs/06-extension.md` | Worlds, message flows, governor math, telemetry itemisation, day-one checklist |
| `docs/07-dashboard.md` | Routes and permissions, auth/CSRF/WS handling, tokens, components, Vercel deployment |
| `docs/08-analytics.md` | Every metric formula, source tables, materialisation schedule, export formats |
| `docs/09-security.md` | Controls inventory with file and test references, key rotation, open findings |
| `docs/threat-model.md` | STRIDE per component, attack vectors with mitigations, residual risks, non-goals |
| `docs/10-design-system.md` | Tokens, typography, components, chart rules, page specs, accessibility |
| `docs/11-devops.md` | Local dev, environments, deployment guide, monitoring runbook, backups, readiness checklist |
| `docs/12-testing.md` | Test strategy, commands, isolation rules, coverage, load thresholds, defects found |
| `docs/13-roadmap.md` | Remaining phases, exit criteria, go-live checklist |

## What this product will and will not do

- It drives the transfer-market app's own controls; it does not forge UTAS
  requests or lift a session token.
- It does not bypass CAPTCHAs or spoof a client.
- Raw market observations never leave the browser. What the backend does
  receive is listed in `docs/06-extension.md`.
- The safety governor cannot be loosened past the admin-set ceiling from the
  UI, and the server kill switch is unconditional.
- The live market is not yet unlocked for this title, so the adapter's
  assumed service-layer shape must be verified on day one against the real
  web app; the checklist is in `docs/06-extension.md`.
