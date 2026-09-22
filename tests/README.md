# @sl/tests

Cross-app end-to-end journeys and load tests for The Sniper's Ledger — the
tests that exercise more than one app at once, or the running server's
behaviour under concurrent traffic. Owned by the Testing & QA agent. See
[`docs/12-testing.md`](../docs/12-testing.md) for the full test strategy
this package fits into.

A single-app suite lives with its own app instead:
[`apps/dashboard/e2e`](../apps/dashboard/e2e), [`apps/extension/test/e2e`](../apps/extension/test/e2e),
or as its own workspace package
([`tests/security`](../tests/security), the security agent's authz/CSRF/
injection suite against the real built API).

## Contents

- [`e2e/`](./e2e) — Playwright, cross-app journeys (extension ↔ real API,
  admin action ↔ another user's live WS connection, a signed Stripe webhook
  ↔ the dashboard). See [`e2e`'s own section of docs/12-testing.md](../docs/12-testing.md#8-testse2e--cross-app-journeys).

  ```bash
  cd tests
  pnpm test:e2e                    # headed — needs a real display or xvfb-run
  xvfb-run -a pnpm test:e2e
  ```

- [`load/`](./load) — k6 load tests against a real running `apps/api`. See
  [`load/README.md`](./load/README.md) and
  [docs/12-testing.md §9](../docs/12-testing.md#9-testsload--k6).

  ```bash
  cd tests
  pnpm load:smoke
  ```

- [`fixtures/`](./fixtures) — empty on purpose; see that directory's own
  README for why (the one fixture this repo's e2e suites need, the mock EA
  web app, already lives with the extension).

## Setup

```bash
pnpm install                                        # repo root
cp infra/env/.env.development.example apps/api/.env # JWT/entitlement keys the e2e-spawned api process needs
```

Both `e2e/` and `load/` need a reachable Postgres + Redis
(`DATABASE_URL`/`REDIS_URL`, defaulting to `127.0.0.1:5432`/`127.0.0.1:6379`
— see `docs/12-testing.md` §3 for the exact values and §4 for which
suite uses which database).

## Package layout

```
tests/
├── e2e/
│   ├── playwright.config.ts   # webServer (api + dashboard), ports 3100/5273
│   ├── prepare.mjs            # db reset+seed + extension build — runs as a
│   │                          # PREFIX to the api webServer command (see its
│   │                          # own header for why, not Playwright's globalSetup)
│   ├── build-extension.mjs    # builds `ledger` pointed at this run's own API origin
│   ├── helpers/                # auth.ts, db.ts, stripe.ts, extension-id.mjs
│   └── specs/                  # a/b/c/d-*.spec.ts, one per journey
├── load/
│   ├── lib/config.js           # shared k6 config (profiles/thresholds)
│   ├── scenarios/               # one k6 script per scenario
│   ├── setup/provision.mjs      # fixture users + admin, before a run
│   ├── run.mjs                  # orchestrator (provision, then every scenario)
│   ├── autocannon-fallback.mjs  # used only if k6 isn't installed
│   └── README.md
├── fixtures/
│   └── README.md
├── package.json      # @sl/tests
└── tsconfig.json
```
