# 13 — Roadmap

Step-by-step implementation plan for The Sniper's Ledger, phase by phase.
Each phase lists concrete steps, exit criteria (what must be true before the
next phase starts), and which milestone (M1/M2/M3) it serves. This mirrors
the orchestrator's wave plan; "wave" groups phases that run in parallel
against the same dependency, "phase" is the unit of work within a wave. See
[`01-architecture.md`](./01-architecture.md) for the system this roadmap
builds toward.

## Milestone mapping

| Milestone           | What it is                                                                                                               | Phases that deliver it                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **M1 — Ledger**     | Read-only recorder. Done, predates this roadmap.                                                                         | — (already shipped, moved into `apps/extension/` in Phase 1)     |
| **M2 — Assist**     | Account, subscriptions, dashboard, opportunity ranker, filter rotation, session P&L, risk meter. Human-in-the-loop only. | 2, 3, 4, 5, 6 (assist layers), 7, 8                              |
| **M3 — Automation** | Autobuyer, gated behind the governor, shipped as the separate `ledger-auto` build.                                       | 6 (automation layer), plus 9/10/11 harden and polish both builds |

Security (9), UI polish (10) and testing (11) apply to M2 and M3 equally and
are not milestone-gated on their own.

---

## Phase 1 — Architecture & scaffolding (wave 0)

**Delivers:** this document, `docs/01-architecture.md`, the pnpm/Turborepo
monorepo, `packages/shared`, `packages/config`, and the extension moved into
`apps/extension/`.

Steps:

1. Write `docs/01-architecture.md` (component/deployment/sequence diagrams,
   trust boundaries, two build targets, scaling notes).
2. Scaffold root config: `package.json`, `pnpm-workspace.yaml`, `turbo.json`,
   `.nvmrc`, `.editorconfig`, `.prettierrc`/`.prettierignore`, root
   `eslint.config.js` (flat config, typescript-eslint, import ordering, the
   no-raw-SQL-interpolation rule), extended `.gitignore`.
3. `packages/config`: shared `tsconfig.base/node/web.json`, ESLint preset,
   Prettier config.
4. `packages/shared`: plan/error/permission constants, every Zod DTO schema
   the API/extension/dashboard will share, WS event types, extension
   internal message types, unit tests, builds to `dist/`.
5. `git mv src apps/extension/src`, `git mv test apps/extension/test`,
   `git mv manifest.json apps/extension/manifest.json`; add
   `apps/extension/package.json`; keep the milestone-1 code byte-identical.
6. Rewrite the root `README.md`; move the original README to
   `apps/extension/README.md`.
7. Write this roadmap.

**Exit criteria:**

- `pnpm install` succeeds at the repo root.
- `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build` all
  pass, including `apps/extension`'s `node --test` suite unchanged after the
  move.
- `git status` shows the extension files as renames (`git mv`), not
  delete+add.

---

## Phase 2 — Database (wave 1)

**Delivers:** `packages/db` — Drizzle schema, numbered SQL migrations, seed
script, ERD in `docs/02-database.md`.

Steps:

1. Establish the per-table conventions (`id uuid` v7, `created_at`,
   `updated_at` via `set_updated_at()` trigger, `deleted_at` soft delete with
   partial indexes, `row_version`, `created_by`/`updated_by` where an actor
   exists).
2. Write the full schema: `users`, `admin_users` + `admin_actions`, `plans`,
   `subscriptions`, `licenses`, `devices`, `sessions`, `email_verifications`,
   `password_resets`, `totp_recovery_codes`, `user_activity` (partitioned),
   `search_activity` (partitioned), `sniping_activity` (partitioned),
   `trades`, `profits`, `saved_filters` + `filter_stats`,
   `risk_budget_events`, `user_settings` + `settings_history`,
   `notifications`, `payments` + `payment_history` +
   `stripe_webhook_events`, `coupons` + `coupon_redemptions`, `bans` +
   `flags`, `audit_logs` (append-only, partitioned), `feature_toggles` +
   `system_config`, `ip_activity`, `extension_installs`,
   `analytics_daily` + MRR/ARR/churn views. **No `market_observations`
   table** — raw listings stay in the browser (`01-architecture.md` §5).
3. Write numbered migrations (Drizzle-kit `migrate`) and a seed script
   (plans, feature toggles, system config, one super admin from env, one dev
   user).
4. `docs/02-database.md`: ERD (Mermaid) + column-by-column notes per table.

**Exit criteria:**

- `pnpm --filter @sl/db migrate` runs clean against a fresh local Postgres
  16 (`127.0.0.1:5432`, db `sniper_ledger`).
- `pnpm --filter @sl/db seed` populates plans/toggles/config/admin/dev user
  idempotently (safe to re-run).
- `pnpm --filter @sl/db typecheck && test` pass.
- Every table matches the conventions above; a lint pass over
  `packages/db` triggers zero hits on the no-raw-SQL-interpolation rule.

---

## Phase 3 — Backend core (wave 2)

**Delivers:** `apps/api` skeleton — Fastify app, plugin chain, route
groups, WS gateway, jobs, OpenAPI spec, `docs/03-api.md`.

Steps:

1. Plugin order: config (env schema) → otel → pino → security headers
   (helmet) → CORS (allowlist + extension origin) → cookie → csrf (dashboard
   only) → rate-limit (Redis) → db → redis → auth decorators → routes.
2. `x-request-id` on every request; error handler normalises every thrown
   `AppError` to `{ code, message, details?, requestId }` using
   `@sl/shared`'s `ERROR_STATUS` map.
3. Cursor pagination (`@sl/shared`'s `paginationQuerySchema`) on every list
   route.
4. Route groups: `auth/*`, `users/me`, `devices`, `sessions`,
   `subscriptions`, `licenses`, `payments` (+ `webhooks/stripe`), `coupons`,
   `settings`, `notifications`, `activity`, `sniping`, `trades`, `profits`,
   `filters` (+ `filters/stats`), `risk-events`,
   `extension/{bootstrap,heartbeat,telemetry,errors,version,kill-switch}`,
   `admin/*`, `health/{live,ready}`, `metrics`.
5. WS gateway `/ws` (ticket auth), channels `user:{id}` and
   `admin:overview`, Redis presence.
6. Jobs: `profits.rollup` (hourly), `analytics.daily` (nightly),
   `subscriptions.expire` (5 min), `licenses.revalidate`, `abuse.scan`,
   `email.send`, `audit.retention`.
7. Generate + commit `apps/api/openapi/openapi.json`; write
   `docs/03-api.md` listing every route with its auth requirement and rate
   limit.

**Exit criteria:**

- `pnpm --filter @sl/api dev` boots against local Postgres/Redis;
  `curl /health/ready` returns 200.
- Every route group has at least a smoke integration test via Fastify
  `inject`.
- `docs/03-api.md` route count matches the OpenAPI spec's path count.

---

## Phase 4 — Authentication (wave 2, same backend agent)

**Delivers:** register/login/MFA/refresh/reset flows, sessions, admin roles.

Steps:

1. Register → email verification (argon2-hashed token, 24h expiry); login
   blocked until verified (config flag).
2. Password policy via `@sl/shared`'s `passwordSchema`; argon2id hashing;
   optional HIBP k-anonymity check (feature-flagged).
3. JWT access (EdDSA, 15 min, claims `sub/sid/did/role/plan/ver`) + opaque
   refresh (32 random bytes, hashed, 30 days, rotation with family reuse
   detection).
4. Device-limit enforcement at login/registration using
   `@sl/shared`'s `DEVICE_LIMITS`; `DEVICE_LIMIT_REACHED` when no eviction
   policy applies.
5. Lockout: 5 failures → 15 min, exponential backoff; Redis sliding-window
   rate limits per IP and per account.
6. Password reset (1h single-use token, revokes all sessions on success).
7. TOTP enrol/verify/disable, 10 recovery codes, `mfa_required` step-up
   ticket on login.
8. Admin roles + `packages/shared`'s `hasPermission`/`PERMISSION_MATRIX`
   wired into a `requirePermission('x.y')` route decorator; admin 2FA
   mandatory.
9. Force logout: revoke sessions, bump token `ver`, WS push
   `session.revoked` (`01-architecture.md` §3.7).

**Exit criteria:**

- Integration tests cover: register→verify→login, login with MFA,
  lockout after 5 failures, refresh rotation + reuse detection revoking the
  family, device-limit rejection, force logout revoking an active session.
- `docs/04-auth.md` documents every flow with a sequence diagram matching
  `01-architecture.md` §3.1.

---

## Phase 5 — Subscriptions & payments (wave 2)

**Delivers:** plans, Stripe integration, license keys, trial-abuse
protection, admin billing endpoints.

Steps:

1. Seed plans (`trial` 7d/1 device, `basic` 1 device, `pro` 2 devices,
   `ultimate` 3 devices + all features, `lifetime` one-time) matching
   `@sl/shared`'s `DEVICE_LIMITS`/`PLAN_FEATURES`.
2. Stripe Checkout + Customer Portal; webhook handlers
   (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.*`) — signature-verified, idempotent via
   `stripe_webhook_events`. Local DB state is the source of truth,
   reconciled by webhook + nightly sync job.
3. License keys `SL-XXXX-XXXX-XXXX-XXXX` (Crockford base32 + checksum);
   only the hash is stored. `/extension/bootstrap` and
   `/extension/heartbeat` return entitlements per `01-architecture.md` §3.2,
   with the 24h offline grace.
4. Trial-abuse protection: one trial per normalised email domain
   (gmail dots/plus), per device fingerprint, per IP/24 within 30 days;
   violations write to `flags` and deny the trial (`TRIAL_ABUSE_DETECTED`).
5. `abuse.scan` job: device-registration velocity, one license across many
   IPs/ASNs, chargebacks → auto-suspend + flag.
6. Admin endpoints: activate/extend/suspend/cancel subscription, grant
   lifetime, create/disable coupons, ban/unban — every one audited
   (`01-architecture.md` §3.6).

**Exit criteria:**

- A full Stripe test-mode Checkout → webhook → entitlement flow works
  end-to-end against Stripe's test clock for renewals/cancellations.
- Trial-abuse tests cover all three vectors (email/device/IP) with both a
  true positive and a false-positive-avoidance case.
- `docs/05-subscriptions.md` documents the license format, webhook
  idempotency strategy, and the offline-grace state machine.

---

## Phase 6 — Extension core logic (wave 2)

**Delivers:** TypeScript rewrite of `apps/extension` on Vite/crxjs, the
`ledger`/`ledger-auto` build split, the M2 assist engine and M3 automation
module.

Steps:

1. Migrate `apps/extension` to TypeScript, `webextension-polyfill`, Vite +
   `@crxjs/vite-plugin` multi-entry build; `manifest.json` gains
   `update_url` (placeholder for `ledger`, self-hosted for `ledger-auto`),
   `host_permissions` = EA origins + API origin only, strict CSP.
2. `main/adapter.ts`: port milestone-1 passive observation, add `probe()`
   (`01-architecture.md` §3.5) and the `act()` surface
   (`search`/`buy`/`readResult`) driven through the app's own service layer.
3. `store/db.ts` (ported, local-only), `model/prices.ts` (ported verbatim
   with its existing tests, still authoritative — no rewrite).
4. `engine/ranker.ts` (EV scoring, filter rotation/retirement by realised
   coins/hour), `engine/governor.ts` (safety budget: actions/hour, session
   length, buy/search ratio, coin-flow shape, hard stop, kill switch,
   `allow()`), `engine/assist.ts` (M2), `engine/autobuyer.ts` (M3,
   `ledger-auto` only, tree-shaken out of `ledger`).
5. `content/`: engine loop lives here (never the SW), typed message bus
   (`@sl/shared`'s `ext-messages.ts`), crash recovery via
   `storage.session` + watchdog.
6. `background/`: auth/license/settings/telemetry/error-flush via
   `chrome.alarms`, no loops.
7. `lib/api.ts` (bearer + auto-refresh + backoff + request-id), `lib/auth.ts`,
   `lib/license.ts`, `lib/settings.ts`, `lib/telemetry.ts`, `lib/errors.ts`.
8. `popup/` and `options/` UIs, including the "What it sends" page mirroring
   `01-architecture.md` §5.
9. Panel gains price history, session P&L, budget meter, ranker view.

**Exit criteria:**

- `pnpm --filter @sl/extension build` produces a loadable `ledger` build and
  a separate loadable `ledger-auto` build from the same source tree; the
  `ledger` build's bundle contains no reference to `autobuyer.ts`.
- The ported `model/prices.ts` test suite still passes unchanged in intent.
- Governor unit tests cover every threshold type denying at its boundary.
- `docs/06-extension.md` includes the "What it sends" table and the build
  commands for both targets.

---

## Phase 7 — Dashboard (wave 3)

**Delivers:** `apps/dashboard` — user + admin React app.

Steps:

1. Bootstrap React 19 + Vite + TanStack Router/Query + Tailwind v4 + Radix
   primitives, API client generated from the committed OpenAPI spec
   (`openapi-typescript`).
2. Auth pages: Login, Register, Verify email, Reset password, 2FA — httpOnly
   cookie session, CSRF token on mutations.
3. User area: Dashboard (profit/snipes/devices), Analytics, Subscriptions
   (plans, checkout, portal, license key, devices), Settings (mirrors
   `@sl/shared`'s `userSettingsSchema` sections).
4. Admin area: Overview KPIs (WS live counters), Users
   (search/edit/suspend/ban/reset/force-logout/subscription control), Profit
   analytics, Activity monitoring, System monitoring, Audit logs (diff
   viewer using `@sl/shared`'s `AuditLogEntry`), Coupons, Plans, Feature
   toggles, System config.
5. Role-gated routing using `@sl/shared`'s `hasPermission` client-side (the
   API remains the enforcement point).

**Exit criteria:**

- Every admin route hides/shows per the same permission matrix the API
  enforces (checked via a role-matrix test, not eyeballing).
- WS-driven overview counters update live in a manual smoke test against
  the dev API.
- `docs/07-dashboard.md` documents every route and its required permission.

---

## Phase 8 — Analytics (wave 3)

**Delivers:** KPI computation, profit analytics, usage/error metrics.

Steps:

1. `analytics_daily` materialisation job + Postgres views for MRR/ARR,
   conversion, retention cohorts, churn, install counts.
2. Profit analytics queries: per-user daily/weekly/monthly/lifetime,
   leaderboards (top/least, avg, coins traded).
3. Feature usage, extension version distribution, error rates, p50/p95 from
   OTel histograms.
4. CSV/JSON export endpoints (streamed), `/admin/analytics/reports/{kpi,
profits,activity}` with date-range filters.
5. `docs/08-analytics.md`: every metric's exact formula.

**Exit criteria:**

- Every metric in `docs/08-analytics.md` has a corresponding test asserting
  its formula against fixture data.
- Export endpoints stream without loading the full result set into memory
  (verified against a large fixture).

---

## Phase 9 — Security (wave 4)

**Delivers:** hardening pass across API, extension and infra;
`docs/09-security.md` + `docs/threat-model.md`.

Steps:

1. Zod on every input (already the default via `@sl/shared` schemas);
   parameterised queries only, enforced by the repo's
   no-raw-SQL-interpolation ESLint rule against `packages/db` and
   `apps/api`.
2. CSP/HSTS/nosniff/frame-deny via helmet; CSRF double-submit for cookie
   sessions; tiered rate limiting; IP monitoring (geo/ASN enrichment,
   impossible-travel flag); session binding to device fingerprint.
3. Secrets via env, documented path to Doppler/SOPS; pgcrypto column
   encryption for TOTP secrets; refresh tokens hashed at rest; TLS
   everywhere (Caddy auto-TLS, `sslmode=require`); audit trails append-only
   (`REVOKE UPDATE, DELETE` on `audit_logs`); dependency scanning in CI.
4. `docs/threat-model.md`: STRIDE per component, with these attack vectors
   named explicitly and a mitigation + test reference each: token theft,
   license sharing, trial abuse, webhook forgery, extension tampering,
   replay, admin compromise, EA payload injection into the adapter, XSS via
   user-provided names/settings.

**Exit criteria:**

- Every threat-model entry links to a passing test.
- `npm audit`/Semgrep run clean (or every finding is triaged and recorded)
  in CI.
- A manual pass confirms the extension's `host_permissions` are exactly EA
  origins + API origin, nothing broader.

---

## Phase 10 — UI/UX polish & design system (wave 5)

**Delivers:** `packages/ui`, `docs/10-design-system.md`.

Steps:

1. Dark gaming palette (ground `#0D1311`, surface `#151D1A`, accent gold
   `#DDB35C`, live green `#55c08e`/`#6FBF9B`, risk red `#E08678`),
   typography (Inter + JetBrains Mono, tabular-nums for numbers).
2. Component library: Button, Card, StatTile, DataTable, Chart wrappers,
   Modal, Toast/Notification, Badge, Tabs, Form fields; motion tokens
   (150–250ms, reduced-motion respected); responsive breakpoints.
3. Apply consistently across dashboard, popup, options and the in-page
   panel; charts follow the `dataviz` skill's guidance.

**Exit criteria:**

- Every component in the library has a visual regression/story reference.
- The extension panel and the dashboard render the same numeric card style
  (tabular-nums, same palette tokens) side by side.

---

## Phase 11 — Testing & QA (wave 5)

**Delivers:** the full test pyramid, `docs/12-testing.md`.

Steps:

1. Unit: Vitest across API modules, `@sl/shared` schemas (already started
   in Phase 1), extension engine/model, dashboard components.
2. Integration: API against Postgres+Redis (`pnpm test:integration`) —
   auth flows, subscription lifecycle with mocked Stripe events, license
   validation, admin actions → audit rows, ingest → rollups.
3. E2E (Playwright): dashboard (register→verify→login→2FA→checkout
   mock→admin actions); extension loaded in Chromium against
   `tests/fixtures/mock-ea-app` (a static page replaying recorded UTAS
   `transfermarket` payloads), verifying observation, panel, engine
   decisions and upload.
4. Load: k6 scripts for auth, ingest, analytics endpoints with thresholds.
5. Security tests: authz matrix, rate-limit/lockout, CSRF, injection payload
   suites, webhook signature verification; optional ZAP baseline job in CI.
6. CI runs everything except load tests on every PR; `docs/12-testing.md`
   documents the strategy and how to run each suite locally.

**Exit criteria:**

- CI is green on the full pyramid (minus load) for a representative PR.
- The extension E2E suite passes against the mock EA app fixture without
  any live EA traffic (market stays locked — see the go-live checklist).
- `pnpm -r test` and `pnpm --filter @sl/api test:integration` both documented
  and reproducible from a clean checkout.

---

## Final wave — docs review (wave 6, orchestrator)

Review every `docs/*.md` against the ten deliverables (architecture,
database, API, auth, subscriptions, extension, dashboard, analytics,
security + threat model, design system) plus this roadmap and testing docs,
confirm cross-references resolve, and commit/push to
`claude/happy-knuth-850cu9`.

---

## Go-live checklist

The EA market is locked for this build — nothing here has been run against
live EA traffic. This checklist is what "market still locked" means in
practice and what has to happen before it isn't.

### Verify against the live EA app on day one

- [ ] Load `ledger` unpacked against the real EA web app (not the mock
      fixture) and confirm `adapter.ts`'s `probe()` reports `ok: true` — if
      it doesn't, the bundle has changed shape and the hard-stop must engage
      before anything else runs.
- [ ] Confirm passive observation still parses real market responses
      (`kind: 'auctions'`, not `kind: 'shape'`) across a sample of at least
      50 real searches.
- [ ] Manually exercise `act('search')` and `act('buy')` against a low-value
      throwaway trade to confirm the adapter genuinely drives the app's own
      controls (watch the network tab: the request must be indistinguishable
      from one the UI itself would issue).
- [ ] Run a short session with the governor's default thresholds and confirm
      the risk meter, cooldowns and hard-stop all fire as designed — this is
      the safety claim, so it gets verified before anything else does.
- [ ] Re-run the full `tests/fixtures/mock-ea-app` suite one more time
      immediately before and after the live check, to isolate "the fixture
      is stale" from "the live app changed."

### Chrome Web Store listing

- [ ] Prepare the `ledger` build's listing copy, screenshots, and privacy
      disclosure matching `docs/06-extension.md`'s "What it sends" table
      exactly (no more, no less than what's declared).
- [ ] Confirm `host_permissions` in the submitted manifest are exactly the
      EA origins + API origin (Phase 9's manual pass, re-run on the
      submission build).
- [ ] Submit for review; `ledger-auto` is **not** submitted — it stays
      self-hosted per `update_url`, per CWS policy on gameplay automation.

### Stripe live keys

- [ ] Swap test-mode keys for live-mode keys via the env/secrets mechanism
      documented in `docs/09-security.md` — never committed, never logged.
- [ ] Point the webhook endpoint at the live Stripe dashboard and verify one
      real low-value transaction end-to-end (Checkout → webhook →
      entitlement → extension bootstrap picks it up).
- [ ] Confirm the nightly reconciliation job runs clean against live data
      for at least one full cycle before relying on webhooks alone.

### DNS / TLS

- [ ] Point the production domain(s) at the VM (§2a); confirm Caddy issues
      and renews certificates automatically.
- [ ] Confirm `sslmode=require` is enforced end-to-end (API → Postgres) and
      that the extension's API origin matches the manifest's declared
      `host_permissions` exactly.

### Backups restore drill

- [ ] Run the `pg_dump` cron container once, capture a real backup.
- [ ] On a throwaway instance, restore that backup and confirm the app boots
      against the restored database with data intact.
- [ ] Document the restore runbook's actual wall-clock time in
      `docs/11-devops.md` — this is what an incident response plan needs,
      not just "we have backups."
