# The Sniper's Ledger

A commercial-grade SaaS companion for EA FC Ultimate Team transfer-market
sniping, built on a private, per-user record of what the market actually did
— not a crowd-sourced guess. It ships in three milestones:

- **M1 — Ledger (done).** A read-only MV3 extension that passively records
  market listings into local IndexedDB and shows floor / median / sell-through
  / max-snipe in an in-page panel. No account, no server, no automation.
- **M2 — Assist.** Human-in-the-loop opportunity ranking, filter rotation by
  realised coins/hour, session P&L, and a visible risk-budget meter, backed
  by an account, subscriptions and a dashboard.
- **M3 — Automation.** An autobuyer gated behind the safety governor,
  distributed as a **separate extension build** from the listable one.

Two rules hold across every milestone: the extension only ever **drives the
game's own service layer**, never forges a request; and the **safety
governor** sits between every decision and every action so the product stops
you before you look like a bot — it is never sold as "undetectable." See
`docs/01-architecture.md` for how that is enforced end to end.

## Layout

This is a pnpm + Turborepo monorepo.

```
apps/
  extension/    MV3 browser extension (M1 today; M2/M3 TypeScript rewrite is a later wave)
  api/          Fastify backend — REST + WS + workers            (wave 2+)
  dashboard/    React admin + user dashboard                     (wave 3+)
packages/
  shared/       Zod schemas, DTOs, error codes, plan/permission constants, WS & extension message types
  config/       Shared tsconfig / ESLint / Prettier configuration
  db/           Drizzle schema, migrations, seed, ERD            (wave 1+)
  ui/           Design system (tokens, components)                (wave 5+)
infra/          Docker, Compose, Caddy, Prometheus/Grafana/Loki   (wave 4+)
tests/          e2e (Playwright), load (k6), security, fixtures  (wave 5+)
docs/           Architecture, database, API, auth, subscriptions, extension,
                dashboard, analytics, security, design system, DevOps,
                testing, roadmap — see docs/01-architecture.md to start
```

`apps/api`, `apps/dashboard`, `packages/db`, `packages/ui`, `infra/` and
`tests/` are scaffolded by later waves of the build (see
`docs/13-roadmap.md`) and don't exist yet on this branch.

## Quick start

Requirements: Node 22, pnpm (via Corepack), a local PostgreSQL 16 and Redis 7
(see `docs/01-architecture.md` for the compose-based dev stack once
`packages/db` and `apps/api` land).

```bash
corepack enable
pnpm install

# once packages/db and apps/api exist:
#   docker compose up -d postgres redis
#   pnpm --filter @sl/db migrate && pnpm --filter @sl/db seed
#   pnpm --filter @sl/api dev

pnpm dev          # turbo run dev, across every app
pnpm build        # turbo run build
pnpm lint         # turbo run lint
pnpm typecheck    # turbo run typecheck
pnpm test         # turbo run test
pnpm format       # prettier --write across the repo
```

For the extension specifically: `chrome://extensions` → **Developer mode** →
**Load unpacked** → select `apps/extension/`. Its own README
(`apps/extension/README.md`) has the milestone-1 details — what it records,
what it sends (nothing, in M1), and its honest limits.

## Documentation

Start at [`docs/01-architecture.md`](docs/01-architecture.md) — component,
deployment and sequence diagrams, the trust-boundary section (what data
crosses the browser/API boundary and why), and the two extension build
targets. [`docs/13-roadmap.md`](docs/13-roadmap.md) lays out every remaining
phase, exit criteria, and the go-live checklist. The rest of `docs/` fills in
per-domain as each wave of the build lands.

## What this product will and will not do

- It drives the transfer-market app's own controls; it does not forge UTAS
  requests or lift a session token.
- It does not bypass CAPTCHAs or spoof a client.
- Raw market observations never leave the browser — there is no server-side
  observation table, even once accounts and telemetry exist. What the
  backend _does_ receive is listed explicitly in
  `docs/01-architecture.md`'s trust-boundary section.
- The safety governor is not optional and not bypassable from the UI: budgets
  can be tightened by the user, never loosened past the plan's admin-set
  ceiling.
