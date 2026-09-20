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

The build follows a data-first sequence. This table is kept current as each
phase lands on this branch.

| Phase | Scope | Status | Where |
| --- | --- | --- | --- |
| 1 Architecture | Monorepo, shared contracts, diagrams, roadmap | Done | `packages/shared`, `docs/01-architecture.md`, `docs/13-roadmap.md` |
| 2 Database | 35 tables, partitioning, audit, views, seed, tests | Done | `packages/db`, `docs/02-database.md` |
| 3 Backend API | Fastify, 105 routes, WS gateway, jobs, OpenAPI | Done | `apps/api`, `docs/03-api.md` |
| 4 Authentication | JWT + rotating refresh, sessions, devices, 2FA, lockout, admin roles | Done | `apps/api/src/modules/auth`, `docs/04-auth.md` |
| 5 Subscriptions | Plans, trials with abuse protection, licenses, Stripe, coupons, bans, flags | Done | `apps/api/src/modules/{subscriptions,licenses,payments,coupons,plans,bans,flags}`, `docs/05-subscriptions.md` |
| 6 Extension | TypeScript port, ranker, governor, assist, gated autobuyer, popup, options | Done | `apps/extension`, `docs/06-extension.md` |
| 7 Dashboard | React user + admin dashboard | In progress | `apps/dashboard`, `packages/ui`, `docs/07-dashboard.md` |
| 8 Analytics | KPI engine, profit analytics, reports, CSV exports, materialisation jobs | Done | `apps/api/src/modules/{analytics,admin-analytics}`, `docs/08-analytics.md` |
| 9 Security | Hardening pass, threat model | Planned | `docs/09-security.md`, `docs/threat-model.md` |
| 10 UI/UX | Design system polish across dashboard, popup, panel | Planned | `packages/ui`, `docs/10-design-system.md` |
| 11 Testing | Unit, integration, e2e, load, security suites | Planned | `tests/`, `docs/12-testing.md` |
| DevOps | Docker, Compose, CI/CD, monitoring, backups, deploy guides | In progress | `infra/`, `.github/`, `docs/11-devops.md` |

Known follow-ups tracked for the remaining phases: a `stripe_customer_id`
column on users (Customer Portal lookup and a fourth trial-abuse vector), an
atomic trial-to-paid transition through Checkout, an indexed path for the
trial-abuse email scan, and per-user fan-out of the kill switch over
WebSocket (today it reaches extensions through bootstrap and heartbeat).

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

**Shared contracts** (`packages/shared`): plan and feature constants, error
codes, the admin permission matrix, every request and response schema, the
WebSocket event union and the extension message contracts.

## Layout

```
apps/
  api/          Fastify backend: REST, WebSocket, BullMQ workers
  dashboard/    React user + admin dashboard (in progress)
  extension/    MV3 extension, two build targets
packages/
  shared/       Zod schemas, DTOs, error codes, plans, permissions, message contracts
  db/           SQL migrations, Drizzle schema, seed, test utilities
  config/       Shared tsconfig / ESLint / Prettier presets
  ui/           Design system (in progress)
infra/          Docker, Compose, Caddy, monitoring, backups (in progress)
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

# everything
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

API integration tests need `DATABASE_URL`, `TEST_DATABASE_URL` and
`REDIS_URL`; see `apps/api/.env.example`.

## Deployment

The dashboard deploys to Vercel from `apps/dashboard` (see `vercel.json`;
deployments are skipped until that app exists on the branch). The API,
worker, PostgreSQL and Redis run on a VM with Docker Compose behind Caddy;
the DevOps phase adds the images, Compose files, CI/CD and runbooks under
`infra/` and `docs/11-devops.md`.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/01-architecture.md` | Components, deployment, sequence diagrams, trust boundaries, build targets |
| `docs/02-database.md` | ERD, every table, indexes, partitioning and retention runbooks |
| `docs/03-api.md` | Every route with auth, permission, rate limit and schema |
| `docs/04-auth.md` | Token lifetimes, refresh rotation, devices, 2FA, CSRF, admin roles |
| `docs/05-subscriptions.md` | Plan matrix, state machine, license keys, trial protection, Stripe webhooks |
| `docs/06-extension.md` | Worlds, message flows, governor math, telemetry itemisation, day-one checklist |
| `docs/08-analytics.md` | Every metric formula, source tables, materialisation schedule, export formats |
| `docs/13-roadmap.md` | Remaining phases, exit criteria, go-live checklist |

Documents for the dashboard, security, design system, DevOps and
testing are added by their phases.

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
