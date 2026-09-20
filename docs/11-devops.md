# 11 — DevOps

Status: implementation-ready. Covers everything under `infra/`, `.github/`,
the root `.dockerignore`, and the `docker:*`/`ci:*` scripts in the root
`package.json` — local development, environments, image build/tag strategy,
CI/CD, the single-VM production deployment, the Vercel dashboard
deployment, monitoring/alerting, logging, backups/restore/PITR, scaling and
secrets management. Read [`01-architecture.md`](./01-architecture.md) §2
(deployment diagrams) and §7 (scaling notes — the "why", cross-linked from
here rather than repeated) first, [`02-database.md`](./02-database.md) §9
for the schema-level backup context, and
[`07-dashboard.md`](./07-dashboard.md) §5/§9 for the dashboard's own half of
the Vercel/CORS story.

## Contents

1. [Local development](#1-local-development)
2. [Environments](#2-environments)
3. [Image build/tag strategy](#3-image-buildtag-strategy)
4. [CI/CD](#4-cicd)
5. [Single-VM deployment guide](#5-single-vm-deployment-guide)
6. [Vercel dashboard deployment](#6-vercel-dashboard-deployment)
7. [Monitoring / alerting runbook](#7-monitoring--alerting-runbook)
8. [Logging pipeline](#8-logging-pipeline)
9. [Backup / restore / PITR runbook](#9-backup--restore--pitr-runbook)
10. [Scaling notes](#10-scaling-notes)
11. [Secrets management](#11-secrets-management)
12. [Production readiness checklist](#12-production-readiness-checklist)

---

## 1. Local development

Two supported paths — pick one, both target the same `sniper_ledger` /
`sniper_ledger_test` databases on `sl`/`sl`:

### 1a. Docker Compose (recommended — no local Postgres/Redis install)

```bash
cp infra/env/.env.development.example .env
pnpm docker:dev                                    # postgres + redis + mailpit
docker compose -f infra/docker-compose.yml run --rm migrator   # migrate + seed
docker compose -f infra/docker-compose.yml up api worker       # hot-reload via tsx watch, bind-mounted repo
```

`infra/docker-compose.yml` is dev-only (not the production images under
`infra/docker/*.Dockerfile` — those are built/tested by
`docker-compose.staging.yml`/`.prod.yml` and CI's `docker-build` job).
`api`/`worker` run `node:22-alpine` directly with the repo bind-mounted and
`node_modules` swapped for named volumes per workspace package (so
container-native/musl-built binaries like `argon2`'s native addon are never
shadowed by host binaries — see the file's own header comment). Mailpit
captures outgoing email at `http://localhost:8025`. The optional monitoring
stack (otel-collector, prometheus, grafana, loki, promtail, postgres/redis/
node exporters) is gated behind a Compose profile so it isn't a tax on
everyday dev:

```bash
docker compose -f infra/docker-compose.yml --profile monitoring up -d
```

Stop everything: `pnpm docker:dev:down`. Logs: `pnpm docker:dev:logs`.

### 1b. No Compose (Postgres/Redis installed on the host)

```bash
# Postgres 16 + Redis 7 reachable at 127.0.0.1, role sl/sl, matching
# infra/postgres/init/01-create-test-database.sql's expectations:
createuser -s sl && createdb -O sl sniper_ledger
psql -U sl -d sniper_ledger -f infra/postgres/init/01-create-test-database.sql

cp infra/env/.env.development.example apps/api/.env
pnpm install
pnpm --filter @sl/db migrate
SEED_ADMIN_EMAIL=admin@sniperledger.local SEED_ADMIN_PASSWORD=dev-only-change-me \
  pnpm --filter @sl/db seed
pnpm --filter @sl/api dev          # terminal 1
pnpm --filter @sl/api worker       # terminal 2 (optional — only needed to exercise BullMQ jobs)
pnpm --filter @sl/dashboard dev    # terminal 3
```

Validate any `.env` file against `@sl/api`'s own zod schema before relying
on it — `apps/api/src/config/env.ts`'s `loadEnv`, exercised without booting
the app:

```bash
pnpm ci:check-env                  # infra/env/.env.development.example
node infra/scripts/check-env.mjs <path>   # any other file
```

## 2. Environments

| Environment | Compose file | Env file (from `.example`) | Deployed by | Trigger |
| --- | --- | --- | --- | --- |
| development | `infra/docker-compose.yml` | `.env` (repo root) or `apps/api/.env` | developer, locally | manual |
| staging | `infra/docker-compose.staging.yml` | `infra/.env.staging` | `.github/workflows/release.yml` `deploy-staging` | push to `main` |
| production | `infra/docker-compose.prod.yml` | `infra/.env.production` | `.github/workflows/release.yml` `deploy-production` | push tag `vX.Y.Z`, gated by the `production` GitHub Environment's required reviewers |

Every `.env.*.example` documents every variable `apps/api/src/config/env.ts`
declares (Zod schema — validated by `check-env.mjs`), plus the compose
file's own `${VAR}` interpolation (`DOMAIN`, `IMAGE_TAG`, replica counts,
`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, Grafana/backup credentials — see each
file's own comments). Staging and production `.example` files are
templates: several fields marked `REQUIRED` are intentionally left blank
(`COOKIE_SECRET`, `JWT_*`, `ENTITLEMENT_*`, `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, …) and `check-env.mjs` fails against them as-is by
design — fill them in first (§11). Only
`infra/env/.env.development.example` is expected to validate unmodified
(it's committed with real, dev-only, safe-to-share values — the CI job
`ci-success` depends on `api-integration-tests`, which asserts this).

## 3. Image build/tag strategy

Five images, all multi-stage, `node:22-alpine` (or `postgres:16-alpine` for
`backup`, `caddy:2.9-alpine` for `caddy`), non-root, `tini` as PID 1, pinned
`corepack pnpm@12.5.1`, OCI labels (`org.opencontainers.image.*` — title,
description, revision, version, created, source):

| Image | Dockerfile | Targets |
| --- | --- | --- |
| `api` | `infra/docker/api.Dockerfile` | `server` (Fastify REST/WS, `HEALTHCHECK` on `/health/live`), `worker` (BullMQ, `HEALTHCHECK` opens a raw TCP connection to Redis) — same pruned `pnpm deploy` output, different `CMD` |
| `dashboard` | `infra/docker/dashboard.Dockerfile` | nginx SPA (self-host option only — Vercel, §6, is primary) |
| `db-migrator` | `infra/docker/db-migrator.Dockerfile` | one-shot: `@sl/db migrate` then optional seed (`RUN_SEED=true`) |
| `backup` | `infra/docker/backup.Dockerfile` | supercronic running `infra/backups/*.sh` on a schedule |
| `caddy` | `infra/docker/caddy.Dockerfile` | Caddy + the `caddy-ratelimit` plugin (not in the stock image) |

**Local build** (no push): `pnpm docker:build:api` / `:worker` / `:dashboard`
/ `:migrator` / `:backup` (root `package.json`), or directly:

```bash
docker build -f infra/docker/api.Dockerfile --target server -t sniper-ledger/api:local .
```

Build context is **always the repo root** (every Dockerfile needs the whole
pnpm workspace to resolve `workspace:*` deps before `pnpm deploy --prod`
prunes to a standalone output) — the root `.dockerignore` keeps that context
small (excludes `node_modules`, `dist`, `docs`, `tests`, env files except
the committed `.example` ones, etc.).

**Tagging** (`.github/workflows/release.yml`, `docker/metadata-action`):
pushed to `ghcr.io/<owner>/<image>` on every push to `main` (tag: `main`,
`sha-<full sha>`) and on every `vX.Y.Z` tag (tags: `X.Y.Z`, `X.Y`, `X`,
`sha-<full sha>`). `IMAGE_TAG` in each environment's `.env` file selects
which tag that environment's compose file pulls
(`${REGISTRY:-ghcr.io/sniper-ledger}/api:${IMAGE_TAG}`) — staging tracks
`main`, production is pinned to an exact `vX.Y.Z` and only moves forward on
a deliberate release + `deploy-production` approval. CI's own `docker-build`
job builds (never pushes) `api`/`worker`/`db-migrator`/`dashboard` on every
PR as a build-still-works gate, independent of the release pipeline.

## 4. CI/CD

`.github/workflows/ci.yml` (every PR + push to `main`): `lint`,
`typecheck`, `unit-tests` (shared/ui/extension, no external services),
`db-migration-test` (fresh Postgres, migrate → status → re-migrate
idempotently, seed twice, `@sl/db`'s own schema/partition/trigger/view test
suite), `api-integration-tests` (Postgres 16 + Redis 7 services, real
`apps/api/.env`), `security-tests` (`tests/security` — authz matrix, CSRF,
rate-limit/lockout, injection, webhook signatures — against the real built
`@sl/api` app, its own dedicated test database and Redis logical DB so it
never collides with `api-integration-tests`), `extension-build` (both
targets + the `no-autobuyer-in-ledger` grep gate), `dashboard-build`,
`security-scan` (`pnpm audit --prod`, gitleaks, semgrep against
`.github/semgrep/rules.yml`), `docker-build` (buildx, no push),
`e2e-dashboard` and `e2e-extension` (Playwright under `xvfb-run` —
GitHub-hosted runners have no display; see the
`setup-playwright-chromium` composite action, §12's "browsers" note). A
single `ci-success` job (`if: always()`, depends on every job above) is the
one required branch-protection check, so adding a job never means touching
branch protection settings — just adding its name to `ci-success`'s
`needs:` list.

`.github/workflows/codeql.yml`: GitHub's own SAST (`javascript-typescript`,
`build-mode: none`) on every PR/push to `main` plus a weekly schedule,
uploading SARIF to the repo's Security tab — complements `security-scan`'s
dependency/secret/custom-rule checks with continuously-updated CodeQL
queries.

`.github/workflows/release.yml`: builds+pushes all five images (§3) on
every push to `main` and on `vX.Y.Z` tags; on a tag, also zips both
extension build targets (`ledger`, `ledger-auto`) as GitHub Release assets;
migrates the target database (a direct connection from the runner, no SSH —
see that job's own comment for the two supported network shapes); deploys
over SSH (`appleboy/ssh-action`) running
`docker compose -f infra/docker-compose.{staging,prod}.yml pull && up -d`.
Production deploy/migrate both run under the `production` GitHub
Environment, which should have required reviewers configured (one-time
repo setup: **Settings → Environments → production → Required reviewers**).

`.github/actions/setup-pnpm` pins pnpm/Node once (from root
`package.json`'s `packageManager`) for every job in every workflow.
`.github/actions/setup-playwright-chromium` installs `xvfb` + a Chromium
matching whichever workspace package's `@playwright/test` version, at the
fixed path (`/opt/pw-browsers/chromium`) both `apps/dashboard/` and
`apps/extension/`'s `playwright.config.ts` expect.

**Adding a job**: give it a clear `name:`, add its job id to `ci-success`'s
`needs:` list, and it's live — no other file needs to change. `ci.yml` is
deliberately matrix-free per job so this stays a one-line addition.

**Local mirrors** of the CI checks that don't need a live cluster:
`pnpm ci:lint`, `pnpm ci:typecheck`, `pnpm ci:check-env`, `pnpm ci:hadolint`
(needs `hadolint` on `PATH`), `pnpm ci:actionlint` (needs `actionlint`).

## 5. Single-VM deployment guide

Target: a fresh **Ubuntu 24.04 LTS** VM, 2+ vCPU / 4GB+ RAM / 40GB+ disk
(the compose file's resource `limits:` — §12 — assume roughly this size; go
bigger before adding replicas, not instead of them). DNS: `A`/`AAAA`
records for `api.<domain>`, `dashboard.<domain>` (if self-hosting the
dashboard instead of/alongside Vercel — §6) and `grafana.<domain>` pointed
at the VM's IP before starting Caddy, or its ACME HTTP-01 challenge fails.

### 5.1 Provision the VM

```bash
# As a non-root sudo user (create one first if you provisioned as root):
sudo apt-get update && sudo apt-get upgrade -y

# Docker Engine + Compose plugin (official convenience script):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker   # or log out/in — picks up the docker group without a fresh SSH session

# Firewall: SSH + HTTP/HTTPS only. Everything else (Postgres, Redis,
# Prometheus, Grafana, the app ports themselves) stays behind Caddy/the
# Docker network — nothing else is published to 0.0.0.0 in
# docker-compose.prod.yml.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp   # HTTP/3 (Caddy's Caddyfile enables it)
sudo ufw enable
```

Grafana (`grafana.<domain>`) gets a real TLS cert from the same Caddyfile
but no app-level auth beyond Grafana's own login — the Caddyfile's comment
flags this explicitly: restrict it further at this layer if it needs to be
non-public (a `ufw` rule scoped to a known IP/VPN range, or an
`@internal remote_ip` Caddy matcher added to that site block).

### 5.2 Check out the repo and configure

```bash
sudo mkdir -p /opt/sniper-ledger && sudo chown "$USER" /opt/sniper-ledger
git clone <repo-url> /opt/sniper-ledger
cd /opt/sniper-ledger

cp infra/env/.env.production.example infra/.env.production
# Fill in every REQUIRED value (§11 — prefer rendering this file from a
# secrets manager over hand-editing it in place):
#   COOKIE_SECRET, JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (pnpm --filter @sl/api
#   keys:generate — run this from a machine with the repo installed, not
#   necessarily the VM), ENTITLEMENT_SIGNING_KEY/ENTITLEMENT_PUBLIC_KEY
#   (same generator, a second keypair), POSTGRES_PASSWORD, REDIS_PASSWORD,
#   GRAFANA_ADMIN_PASSWORD, GRAFANA_PG_PASSWORD, DOMAIN, ACME_EMAIL,
#   IMAGE_TAG (a real vX.Y.Z that release.yml has already pushed).
chmod 600 infra/.env.production

node infra/scripts/check-env.mjs infra/.env.production   # must print OK before continuing
```

`release.yml`'s `deploy-production` job expects this same layout already in
place at `/opt/sniper-ledger` on the host named by the `PRODUCTION_SSH_HOST`
secret (repo Settings → Environments → production → secrets:
`PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`, `PRODUCTION_SSH_PRIVATE_KEY`,
plus `PRODUCTION_DATABASE_URL` for the separate `migrate-production` job —
see §11) — this section is what to run **once, by hand**, before the first
automated deploy ever runs.

### 5.3 First migration + seed admin

```bash
docker compose -f infra/docker-compose.prod.yml pull
docker compose -f infra/docker-compose.prod.yml run --rm migrator
```

`docker-compose.prod.yml`'s `migrator` service hard-codes `RUN_SEED=false`
(production never auto-seeds on every deploy) — run the **one-time** super
admin bootstrap by hand against the fresh database instead, then clear the
password from your shell history / the env file:

```bash
docker compose -f infra/docker-compose.prod.yml run --rm \
  -e RUN_SEED=true \
  -e SEED_ADMIN_EMAIL=admin@yourdomain.com \
  -e SEED_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  migrator
```

(Print/save that generated password before it scrolls off — `seed.ts` is
idempotent, so re-running it later **won't** reset the admin's password if
they've already changed it; see `docs/02-database.md` §10.) Log in once as
that admin and enrol TOTP immediately (`docs/04-auth.md` §6 "admin
bootstrap") — admin 2FA is mandatory going forward.

### 5.4 Start the stack

```bash
docker compose -f infra/docker-compose.prod.yml up -d
docker compose -f infra/docker-compose.prod.yml ps      # everything healthy?
curl -sf https://api.<domain>/health/ready && echo OK
```

### 5.5 Zero-downtime restart

Plain `docker compose up -d` is **not** a Swarm-mode rolling update —
`docker-compose.prod.yml`'s `deploy.update_config`/`restart_policy` blocks
only take effect under `docker stack deploy`, not `docker compose up`
(Compose applies `deploy.replicas`/`resources.limits`, but not the rolling
semantics). Two honest options, in increasing order of guarantee:

1. **What `release.yml`'s `deploy-*` jobs actually run** —
   `docker compose pull && docker compose up -d`. With `API_REPLICAS>=2`
   and Caddy's active health check (`health_uri /health/live`,
   `health_interval 10s`) on the `api` `reverse_proxy` block, Caddy stops
   routing to a container the moment it stops responding and resumes once
   its replacement passes a health check — in practice this is a few
   seconds of reduced capacity, not a hard outage, and both the dashboard's
   and extension's API clients retry idempotent requests with backoff. This
   is the documented default and needs no VM reconfiguration.
2. **True rolling update** — put the VM into single-node Swarm mode once
   (`docker swarm init`), then deploy with
   `docker stack deploy -c infra/docker-compose.prod.yml sniper-ledger`
   instead of `docker compose up -d` (same file, no changes needed) — this
   *does* honor `update_config` (`parallelism: 1`, `order: start-first`,
   automatic `failure_action: rollback`). Adopt this if `API_REPLICAS>=2`
   downtime during option 1 is ever measured as a real problem; until then
   it's added operational complexity (Swarm's own `docker stack` commands
   replace `docker compose`'s day-to-day ones) for a gap that mostly
   doesn't show up in practice.

### 5.6 Rollback

```bash
# Roll the images back to the previous known-good tag:
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=v1.2.2/" infra/.env.production
docker compose -f infra/docker-compose.prod.yml pull
docker compose -f infra/docker-compose.prod.yml up -d
```

If the release being rolled back included a migration, decide **before**
rolling the images back whether the migration is safe to leave applied
(most should be — additive, backward-compatible changes only, per
`docs/02-database.md`'s migration conventions) or needs
`pnpm --filter @sl/db migrate:down` run against it first — check
`packages/db/migrations/` for what the release added. Restoring from the
most recent verified backup (§9) is the last resort for anything a
migration rollback can't cleanly undo.

## 6. Vercel dashboard deployment

Vercel is the **primary** dashboard host (`infra/docker-compose.{staging,
prod}.yml`'s `dashboard` + Caddy's `dashboard.$DOMAIN` site block are a
self-host *option*, not the default path). `vercel.json` (repo root)
already points `installCommand`/`buildCommand` at the pinned
`pnpm@12.5.1`/`pnpm --filter @sl/dashboard... build`, `outputDirectory` at
`apps/dashboard/dist`, and its `ignoreCommand` builds once `apps/dashboard/`
exists (it does). One-time setup in the Vercel project:

1. Import the repo, framework preset **Other** (matches `vercel.json`'s
   `"framework": null` — Vite's own build is driven by `buildCommand`).
2. Set the **`VITE_API_ORIGIN`** project environment variable to the
   deployed API's origin, e.g. `https://api.sniperledger.com` (Production)
   / `https://api.staging.sniperledger.com` (Preview, if previews should
   hit staging). Leaving it unset makes the built dashboard call its own
   Vercel origin as the API, which doesn't exist there — see
   `docs/07-dashboard.md` §9.
3. On the API side, set **`DASHBOARD_ORIGIN`** (`infra/.env.{staging,
   production}`) to the *exact* dashboard origin Vercel serves — the API's
   CORS allowlist (`apps/api/src/plugins/cors.ts`) matches the `Origin`
   header by exact string, and it's also what the API sends as
   `Access-Control-Allow-Origin`/embeds in cookie-scoping logic.

**Cookie/CORS shape — read before pointing a Vercel deployment at a
different apex domain than the API.** `docs/07-dashboard.md` §5 lays out
two shapes:

- **Same-site** (dashboard and API share a registrable domain, e.g.
  `dashboard.sniperledger.com` + `api.sniperledger.com`, or a Vercel
  rewrite that proxies `/api/*` through the dashboard's own origin to the
  real API): the browser only ever needs `SameSite=Lax` cookies, which is
  what `apps/api/src/modules/auth/index.ts` and
  `apps/api/src/plugins/csrf.ts` set today — `sl_at`/`sl_rt`/`sl_csrf` all
  hard-code `sameSite: 'lax'`. **This is the shape this deployment
  currently supports and the one to use.**
- **Cross-site** (dashboard on a Vercel-issued domain like
  `*.vercel.app` or any domain that does *not* share a registrable apex
  with the API): `SameSite=Lax` cookies are **not** sent on cross-site
  fetch/XHR requests, so login would appear to succeed (the response sets
  the cookie) but every subsequent authenticated request would look
  logged-out. Fixing this needs an API-side change —
  `sameSite: 'lax'` becoming a conditional `'none'` (with `secure: true`,
  which cross-site cookies require) when the deploy shape calls for it —
  which **has not been implemented** (flagged here for whoever owns
  `apps/api/src/modules/auth` next; also flagged in
  `docs/07-dashboard.md` §5 as "outside this app's ownership"). Until that
  lands, deploy the dashboard on a subdomain of the same apex as the API,
  or in front of a same-site proxy/rewrite, not on a bare
  `*.vercel.app`/foreign-domain origin.

## 7. Monitoring / alerting runbook

Every alert in `infra/monitoring/prometheus/alert-rules.yml` links back to
its entry below by anchor (`description: "... Runbook: docs/11-devops.md#<anchor>"`).
Dashboards: `infra/monitoring/grafana/dashboards/{api-overview,db-redis,
business-kpis}.json`, auto-provisioned (`infra/monitoring/grafana/
provisioning/`) — reachable at `grafana.<domain>` (or `localhost:3001`
locally, `--profile monitoring`).

#### api-down

`APIDown` — Prometheus hasn't scraped the `sniper-ledger-api` target
(`/metrics`, `prom-client`) in 1 minute. **Response**: `docker compose ps`
— is the container running/restarting in a loop? `docker compose logs
api --tail 200` for a crash on boot (commonly: a bad env var post-deploy —
check `docker compose logs migrator` too in case the last deploy's
migration failed and left the schema mid-change). If it's up but
unreachable, check Caddy's own logs and the Docker network. If all replicas
are down, this is a hard outage — page immediately (`severity: critical`).

#### high-5xx-rate

`HighServerErrorRate` — over 5% of requests 5xx for 5 minutes.
**Response**: Grafana's "API Overview" dashboard's error-rate-by-route
panel narrows which route; `docker compose logs api` or the Loki datasource
(filtered `service="api" level="error"`) for the actual exception. Common
causes: a bad deploy (check what changed — `git log` since the last known-good
tag), Postgres/Redis connectivity (cross-check `DBDown`/connection-pool
exhaustion), or a downstream dependency (Stripe, SMTP) timing out under
load without a circuit breaker.

#### high-p95-latency

`HighP95Latency` — p95 request latency over 1s on some route for 10
minutes (`severity: warning`, not critical — it's a degradation, not an
outage). **Response**: the offending `route` label narrows it in Grafana;
check for a missing index (an unexpectedly slow query — Postgres's own
`pg_stat_statements` if enabled, or `EXPLAIN ANALYZE` the suspect query by
hand), N+1 query patterns, or a queue backlog making a synchronous
request wait on work that should be async (cross-check
`QueueBacklogGrowing`).

#### queue-backlog-growing

`QueueBacklogGrowing` — a BullMQ queue's `wait` list has stayed above 500
for 15 minutes (`redis-exporter`'s `--check-keys` exports `bull:*:wait`
list length as `redis_key_size`). **Response**: `docker compose ps worker`
— is it running? `docker compose logs worker` for a processor throwing
repeatedly (a poison-pill job retried forever without a dead-letter
policy would show as a stuck, non-shrinking backlog). If the worker is
healthy but genuinely under-provisioned for the current job rate, bump
`WORKER_REPLICAS` in the env file and redeploy (§10).

#### db-connections-near-limit

`DBConnectionsNearLimit` — `sniper_ledger`'s active backends are over 80%
of `max_connections`. **Response**: `SELECT count(*), state FROM
pg_stat_activity WHERE datname='sniper_ledger' GROUP BY state;` — a large
`idle` count usually means a connection leak (a pool not releasing clients,
or `API_REPLICAS` × per-process pool size simply exceeding
`max_connections` — the fix there is lowering the per-process pool size,
not raising `max_connections` indefinitely on a single small VM). A large
`active` count under real load is a genuine capacity signal.

#### db-down

`DBDown` — `postgres_exporter` can't reach Postgres (`pg_up == 0`).
**Response**: `docker compose ps postgres`; `docker compose logs postgres`
for a crash (commonly OOM on a memory-constrained VM, or a full disk —
cross-check `DiskSpaceLow`/`DiskSpaceCritical`, which fire independently on
the same underlying cause). If the container is healthy but the exporter
can't authenticate, check `DATA_SOURCE_NAME`/`POSTGRES_PASSWORD` drifted
out of sync between the `postgres` and `postgres-exporter` services' env.

#### disk-space-low

`DiskSpaceLow` (< 15% free, warning) / `DiskSpaceCritical` (< 5% free,
critical) — Postgres, backups (§9) and container logs all live on this
VM's disk in the single-VM deployment. **Response**: `docker system df` and
`du -sh /var/lib/docker/volumes/*` to find what's growing; usual suspects
are Postgres WAL/bloat (a stuck replication slot, or a long-idle
transaction blocking `VACUOM`), backup retention not pruning as expected
(check `infra/backups/pg-backup.sh`'s cron log via `docker compose logs
backup`), or container log growth outdoing the `max-size`/`max-file`
rotation set on every service in `docker-compose.prod.yml` (bump
provisioned disk before this becomes urgent — it's cheaper than an
emergency prune under pressure).

#### backup-too-old

`BackupTooOld` — no successful Postgres backup in over 26 hours (the daily
job runs at 02:00 UTC; 26h gives one full missed run of slack before
paging). **Response**: `docker compose logs backup` for
`infra/backups/pg-backup.sh`'s own output — a `pg_dump` failure (Postgres
unreachable, disk full — cross-check `DBDown`/`DiskSpaceLow`) or an S3
upload failure (non-fatal to the metric by design — check for the
`WARNING: S3 upload failed` line specifically, since that alone would
*not* trigger this alert; if the alert *is* firing, the local dump itself
failed). Run `docker compose exec backup /app/pg-backup.sh` by hand to see
the failure live.

#### backup-verify-failed

`BackupVerifyFailed` — the latest backup restored into a scratch database
and the sanity checks (or the restore itself) failed. **Response**: this
means the backup that exists **may not be usable** — treat as urgent even
though it isn't paired with data loss yet. `docker compose logs backup |
grep verify-backup` for which check failed. Run
`docker compose exec backup /app/verify-backup.sh` by hand for full output.
If it's a corrupt dump specifically, the *previous* day's backup is the
last known-good restore point until the next successful one — see §9's
drill checklist for confirming that one is actually restorable too.

## 8. Logging pipeline

`apps/api` logs structured **pino JSON** to stdout (`docs/03-api.md` §1) —
every container's stdout is captured by Docker's `json-file` log driver
(rotated per-service: `max-size`/`max-file` set on every service in
`docker-compose.{staging,prod}.yml`, e.g. 20MB × 5 files for app services,
50MB × 10 for Postgres) and separately shipped by **Promtail**
(`infra/monitoring/promtail/promtail-config.yaml`, tails
`/var/lib/docker/containers` via the Docker service-discovery mechanism,
parses the pino JSON, promotes `level`/`module`/`service`/`container` to
Loki labels) into **Loki**
(`infra/monitoring/loki/loki-config.yaml`, single-binary mode,
filesystem storage). **Retention: 14 days**
(`limits_config.retention_period: 336h`, enforced by Loki's own compactor)
— deliberately short, because `audit_logs` (Postgres, append-only,
retained indefinitely — `docs/02-database.md` §6.9) is the
compliance-grade record of "what changed and who did it"; Loki only needs
to cover recent operational debugging. Query logs in Grafana's Explore view
against the Loki datasource, or narrow with LogQL directly, e.g.
`{service="api"} | json | level="error"`.

## 9. Backup / restore / PITR runbook

**Schedule** (`infra/docker/backup.crontab`, inside the `backup` service —
UTC): `pg-backup.sh` 02:00 daily, `redis-backup.sh` 02:30 daily,
`verify-backup.sh` 03:30 daily (verifies whatever `pg-backup.sh` produced
30 hours earlier — err, that morning — before anyone needs it).

**What each script does** (`infra/backups/`, connection via standard libpq
env vars — `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`/`PGPASSWORD`, set by the
`backup` service in `docker-compose.{staging,prod}.yml`; local ad hoc runs
export the same vars, e.g. `PGHOST=127.0.0.1 PGUSER=sl PGPASSWORD=sl`):

- **`pg-backup.sh`** — `pg_dump -Fc` (custom format, `--no-owner
  --no-privileges`), gzip, sha256 sidecar. **Retention: 7 daily / 4 weekly
  (every Sunday) / 6 monthly (the 1st)**, independently pruned tiers under
  `$BACKUP_DIR/postgres/{daily,weekly,monthly}/`. Optional S3(-compatible)
  upload via `rclone` if `BACKUP_S3_REMOTE`/`BACKUP_S3_BUCKET` are set (an
  upload failure is logged as a warning, not fatal — the local backup
  already succeeded and is the thing `verify-backup.sh` and the
  `BackupTooOld` alert care about). Writes
  `$BACKUP_DIR/backup_postgres.prom` (`sl_backup_last_success_timestamp_seconds{type="postgres"}`,
  `sl_backup_last_size_bytes`) for node-exporter's textfile collector.
- **`redis-backup.sh`** — `redis-cli --rdb` (a replica-style RDB transfer
  over the wire, so the separate `backup` container never needs filesystem
  access to Redis's own data volume), same gzip/sha256/tiered-retention/S3
  shape. Redis's own state (BullMQ queues, rate-limit counters) is
  disposable operational data, not a source of truth — this snapshot is for
  a faster warm restart, not a recovery-of-record, so there's no
  `verify-backup.sh` equivalent for it.
- **`verify-backup.sh`** — restores the newest daily Postgres dump into a
  disposable scratch database (`sniper_ledger_verify_<timestamp>`, always
  dropped after, success or failure — via a `trap`), asserts
  `schema_migrations`/`users`/`plans`/`subscriptions`/`licenses`/
  `audit_logs` all exist and are queryable, and that at least one migration
  is recorded. Writes `$BACKUP_DIR/backup_verify.prom`
  (`sl_backup_last_verify_status{type="postgres"}`, 1/0).
- **`pg-restore.sh <dump> <target-db> [--create]`** — the restore primitive
  both `verify-backup.sh` and a real disaster-recovery restore use.
  Verifies the `.sha256` sidecar first if present. **Always requires an
  explicit target database** (no implicit default onto `$PGDATABASE`) so a
  restore can never silently overwrite the live database by omission.

**Verified locally** (this pass, against the migrated/seeded dev
`sniper_ledger` database, `sl`/`sl`@127.0.0.1): `pg-backup.sh` produced a
64KB `.dump.gz` + `.sha256` + weekly-tier copy (run on a Sunday) +
`backup_postgres.prom`; `verify-backup.sh` restored it into a scratch
database, all six sanity tables round-tripped correctly (`schema_migrations`:
25 rows, `users`: 3, `plans`: 5, `audit_logs`: 4, `subscriptions`/
`licenses`: 0 — an empty table is a valid pass, the check is
queryability/existence, not a row-count floor), the scratch database was
dropped afterward, and `backup_verify.prom` recorded
`sl_backup_last_verify_status{type="postgres"} 1`. A deliberately-corrupted
copy of the same dump was rejected by `verify-backup.sh` (gzip's own
trailing-garbage check caught it before `pg_restore` even ran) with
`sl_backup_last_verify_status{type="postgres"} 0` and a non-zero exit —
confirming the failure path pages correctly rather than silently passing.
`redis-backup.sh` produced a working `.rdb.gz` via the wire transfer.

### Restore drill checklist

Run this quarterly against **staging**, not production, and whenever
someone new joins the on-call rotation:

1. `docker compose -f infra/docker-compose.staging.yml exec backup ls -la
   /backups/postgres/daily/` — confirm a recent dump exists.
2. `docker compose -f infra/docker-compose.staging.yml exec backup
   /app/verify-backup.sh` — confirm it passes (it also runs automatically
   at 03:30 UTC daily, but run it live for the drill).
3. Pick an actual restore target: either a **new** scratch database (safe,
   repeatable, what step 2 already does under the hood) or, for a fuller
   drill, spin up a **throwaway Postgres container** entirely
   (`docker run --rm -e POSTGRES_PASSWORD=sl -p 5433:5432 postgres:16-alpine`)
   and `PGHOST=127.0.0.1 PGPORT=5433 ./infra/backups/pg-restore.sh
   <dump> sniper_ledger --create` against it — this also exercises "restore
   onto a brand-new instance", the actual disaster scenario, not just
   "restore onto the existing instance".
4. Spot-check business data, not just table existence: row counts roughly
   match what's expected for staging's known seed/test data, a known
   `audit_logs` entry's `before`/`after` diff round-trips.
5. Record the drill (date, who ran it, dump age at restore time, pass/fail)
   — `docs/13-roadmap.md` or an internal runbook log, whichever this team
   already tracks operational drills in.
6. Time the restore end-to-end — this number is the honest answer to "what
   is our actual RTO", not whatever's written down until it's been
   measured.

### PITR (point-in-time recovery) notes

Not implemented in this pass — `pg-backup.sh` gives daily/weekly/monthly
**snapshot** recovery points (RPO up to ~24h), not continuous
point-in-time recovery. If RPO tighter than "up to a day of data loss"
becomes a real requirement:

- **WAL-G** (or `pgbackrest`) is the natural next step: continuous WAL
  archiving to S3 alongside the existing `pg_dump` snapshots (keep both —
  WAL-G's base backups are a fine replacement for `pg-backup.sh`
  eventually, but the two can coexist during a transition), giving
  restore-to-any-second within the WAL retention window. It needs
  `archive_mode = on`/`archive_command` set in `postgres.conf` (not
  currently set — the bundled `postgres:16-alpine` image runs with
  defaults), a WAL-G sidecar or cron job, and its own restore runbook
  (`wal-g backup-fetch` + `wal-g wal-fetch` + `recovery_target_time`).
- Until then, the mitigations already in place narrow how much a PITR gap
  actually matters: every table is soft-delete (`deleted_at`), so an
  accidental row delete is a single `UPDATE` undo, not a restore
  (`docs/02-database.md` §9); `audit_logs` is append-only and independent
  of any restore, so "what changed and who did it" survives regardless.

## 10. Scaling notes

Operational how-to for the levers `docs/01-architecture.md` §7 explains the
reasoning behind:

- **API replicas.** Bump `API_REPLICAS` in `infra/.env.{staging,
  production}`, then `docker compose up -d` (§5.5 for the zero-downtime
  caveat). Caddy's `reverse_proxy api:3000` block resolves `api` to every
  replica container via Docker's embedded DNS and load-balances
  round-robin with active health checks (`health_uri /health/live`) —
  no Caddy config change needed when the replica count changes.
- **Workers.** `WORKER_REPLICAS` the same way. Each BullMQ queue
  (`profits.rollup`, `analytics.daily`, `subscriptions.expire`,
  `licenses.revalidate`, `abuse.scan`, `email.send`, `audit.retention`)
  scales by its own concurrency setting independent of API capacity — a
  slow analytics job never adds request latency, since it runs in
  `apps/api/src/worker.ts`, a separate process from `server.ts`.
  `QueueBacklogGrowing` (§7) is the signal that a queue specifically (not
  the API) needs more capacity.
- **Redis pub/sub.** The WS gateway is stateless per connection beyond
  "which channels this socket subscribes to" — event delivery goes through
  Redis pub/sub, so any gateway instance can push an event to whichever
  instance actually holds a given user's socket. This is what makes the WS
  role horizontally scalable without sticky sessions (beyond what Redis
  presence tracking already needs) if it's ever split into its own replica
  count separate from the REST role.
- **Postgres.** Vertical scaling (bigger VM / managed Postgres) is the
  right first move on a single-VM deployment — `docs/02-database.md`'s
  monthly-partitioned append-only tables (`user_activity`,
  `search_activity`, `sniping_activity`, `audit_logs`) keep write/prune
  cost roughly constant as data grows, so partition maintenance isn't
  itself a scaling trigger; connection count is (`DBConnectionsNearLimit`,
  §7).
- **When to move to Kubernetes.** `docs/01-architecture.md` §2b has the
  target shape (Deployments for `api`/`ws-gateway`/`worker`/`dashboard`,
  HPA on CPU + queue depth, managed Postgres/Redis, external secrets) —
  not built for this MVP. The trigger is measured VM headroom under real
  traffic, not a fixed user count; `apps/api` already exposes the REST,
  WS and worker roles as three separate process entry points from one
  image specifically so "three Compose services of one image" → "three K8s
  Deployments of one image" is a redeploy, not a rewrite, when that day
  comes.

## 11. Secrets management

Nothing under `infra/env/*.example` is a real secret (dev's are
intentionally safe-to-share placeholder/generated values — see that file's
own header). Staging/production secrets are never committed — `infra/.env.
{staging,production}` are gitignored (`.gitignore`'s `.env.*` /
`!infra/env/*.example` rule) and excluded from every Docker build context
(root `.dockerignore`, same pattern) — but a plaintext file on a VM is
still the weakest link in this chain. Two credible upgrades from "SSH in
and edit the file":

- **Doppler** (or a similar secrets-as-a-service tool): store
  staging/production secrets centrally, inject them at container start via
  `doppler run -- docker compose ... up -d` (replaces `env_file:` with
  Doppler's own env injection, or have Doppler render the `.env.*` file
  just before a deploy) — gives audit logs of who read/changed what and
  rotation without touching the VM by hand.
- **SOPS** (+ age or KMS-backed keys): keep an **encrypted** version of
  `infra/.env.{staging,production}` committed to the repo (`sops -e`),
  decrypt it at deploy time (`sops -d infra/.env.production.enc >
  infra/.env.production`) in the CI job or on the VM. This is the better
  fit if secrets should be reviewable in a PR diff (encrypted) and
  version-controlled alongside the infra that consumes them, rather than
  living only in a third-party dashboard.

Either way, the **GitHub Actions secrets** `release.yml` already depends on
(repo/environment settings, not files in this repo) need setting once:
`STAGING_SSH_HOST`/`_USER`/`_PRIVATE_KEY`, `PRODUCTION_SSH_HOST`/`_USER`/
`_PRIVATE_KEY` (environment: production), `STAGING_DATABASE_URL`,
`PRODUCTION_DATABASE_URL` (environment: production) — plus whatever
`GITHUB_TOKEN`-scoped permissions GHCR push and `gh release create` need,
already granted by `release.yml`'s own `permissions:` block.

**What must be rotated together, and what breaks when you do**: `JWT_*`
invalidates every outstanding access token on rotation (users re-login on
their next request, or silently refresh if their refresh token is still
valid — `docs/04-auth.md`); `ENTITLEMENT_*` invalidates every extension's
cached offline-grace entitlement blob (forces a re-bootstrap on next
heartbeat); `COOKIE_SECRET` invalidates every signed cookie (`sl_csrf`,
and `@fastify/cookie`'s signing) immediately. None of these are silent
failures — each shows up as a wave of re-auths, not corrupted state — but
rotate during low traffic and expect a support-ticket blip regardless.

## 12. Production readiness checklist

- [ ] `infra/.env.production` filled in, `check-env.mjs` passes, `chmod
      600`, not committed (`git status` clean in `infra/`).
- [ ] DNS for `api.<domain>`/`dashboard.<domain>` (if self-hosting)/
      `grafana.<domain>` resolves to the VM before first Caddy start.
- [ ] Firewall: only 22/80/443(+443/udp) open (§5.1); Grafana's public
      reachability is an intentional decision, not an oversight (§5.1's
      note).
- [ ] First migration run, super admin seeded once and its password
      rotated out of the shell/env (§5.3), admin TOTP enrolled.
- [ ] `production` GitHub Environment has required reviewers configured —
      confirm a tag push actually pauses for approval before it ever
      matters for real.
- [ ] Backups running (`docker compose logs backup`), `verify-backup.sh`
      passing (§9), `BACKUP_S3_REMOTE`/`BACKUP_S3_BUCKET` set if
      off-VM backup copies are required by policy — VM-local-only backups
      are a single point of failure with the database they're backing up.
- [ ] Every alert in §7 has a real notification channel wired to
      Prometheus/Alertmanager (not built in this pass — `alert-rules.yml`
      defines the rules; routing them to Slack/PagerDuty/email is the
      next step, tracked in `docs/13-roadmap.md`) — an alert nobody
      receives is not a safety net.
- [ ] Grafana admin password changed from the env default, and (§5.1) its
      public reachability reconsidered if it shouldn't be.
- [ ] `VITE_API_ORIGIN`/`DASHBOARD_ORIGIN` set correctly for whichever
      dashboard deployment shape is live (§6), and the same-site cookie
      constraint (§6) respected — cross-site Vercel-only deploys are not
      yet supported.
- [ ] STRIPE_* set to **live** keys (not test) with the live webhook
      endpoint registered, if billing is going live alongside this deploy
      (`docs/05-subscriptions.md`).
- [ ] A restore drill (§9) has actually been run against this
      environment's own backups at least once, not just against dev.
