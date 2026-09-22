# Threat Model — The Sniper's Ledger

Companion to `docs/01-architecture.md` (component/deployment/sequence
diagrams, trust-boundary table) and `docs/09-security.md` (controls
inventory, mapped file-by-file). This document is the STRIDE decomposition
and the attack-vector catalogue; it does not repeat architecture diagrams,
it references them.

## 1. Scope and method

**Method:** component decomposition + trust boundaries (§2, mirrors
`docs/01-architecture.md` §5's table one level deeper) → STRIDE per
component (§3) → a catalogue of concrete attack vectors, each with
likelihood, impact, mitigation and a test reference (§4) → residual risks
(§5) → explicit non-goals (§6).

**In scope:** the extension (all three worlds), `apps/api` (REST + WS +
workers), Postgres, Redis, Stripe integration, the email pipeline, the
dashboard's trust relationship with the API, CI/CD and Vercel.

**Out of scope for this pass, stated not hidden:** the EA web app's own
security (not this project's system), physical/host security of wherever
Postgres/Redis/the API process run in production (covered operationally in
`docs/11-devops.md`, not re-litigated here), and anything explicitly listed
in §6.

## 2. Decomposition and trust boundaries

```
┌─────────────────────────── Browser (per user) ───────────────────────────┐
│  EA web app (untrusted content)                                          │
│    │ DOM / fetch responses (read-only, passive)                          │
│    ▼                                                                     │
│  MAIN world: adapter.ts ── window.postMessage (origin-checked) ──┐       │
│    (only file that touches EA's page/service layer)              │       │
│                                                                    ▼       │
│  ISOLATED world: content/ (engine loop: governor, ranker, assist/autobuyer)│
│    │ chrome.runtime.sendMessage (extension-internal)                      │
│    ▼                                                                      │
│  SW: background/ (auth, license, settings, telemetry, alarms — no loops)  │
│    │ HTTPS (bearer JWT)                          │ IndexedDB (local only) │
└────┼───────────────────────────────────────────────┼──────────────────────┘
     │                                                (raw observations —
     ▼                                                 never crosses out)
┌─────────────────── apps/api (Fastify) — one trust domain ────────────────┐
│  plugins: config → otel → security(helmet) → cors → cookie → csrf →      │
│  rate-limit → db → redis → auth → routes                                 │
│    │            │            │             │                            │
│    ▼            ▼            ▼             ▼                            │
│  Postgres     Redis        Stripe        Email (SMTP/nodemailer)         │
│  (sslmode=    (rate-limit, (webhooks,    (verification/reset/notice      │
│  require in   sessions,    checkout/     links — HTML-escaped)           │
│  prod)        presence)    portal)                                       │
└────────────────────────────────────────────────────────────────────────┘
     ▲                                              ▲
     │ httpOnly cookie + CSRF double-submit          │ CI/CD: GitHub Actions
     │                                                │ builds/tests/deploys;
┌────┴──────────────┐                          ┌──────┴────────────────────┐
│  Dashboard (Vercel,│                          │  Vercel (dashboard only)  │
│  separate origin)  │                          │  — a second, smaller      │
└────────────────────┘                          │  trust domain: static     │
                                                 │  build artifact + CDN     │
                                                 └───────────────────────────┘
```

Every arrow above is a trust boundary. The full crossing/never-crossing
table is `docs/01-architecture.md` §5; the summary that matters most for
this document: **raw market data has exactly one trust boundary (the
browser) and never gets a second one** — there is no server-side
`market_observations` table, by design (project instruction 6). Everything
that _does_ cross into `apps/api` is the exhaustive, documented list in that
same table.

## 3. STRIDE per component

Legend: **S**poofing, **T**ampering, **R**epudiation, **I**nfo disclosure,
**D**enial of service, **E**levation of privilege.

### 3.1 Extension — MAIN world (`adapter.ts`)

| STRIDE | Threat                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | A malicious/compromised EA page script impersonates the adapter's own postMessage sender                                                                   | `event.source !== window` check on every listener (`main/adapter.ts`, `content/adapter-client.ts`); explicit `targetOrigin` (never `'*'`) on every send                                                                                                                |
| T      | EA changes its web app's internal service-layer shape (deliberately or via an update), silently breaking the adapter's assumptions about what it's calling | Bundle probe (`docs/01-architecture.md` §3.5): verifies expected shape at load, hard-stops loudly (`shape` message → engine halts, panel goes amber) rather than acting on a guess                                                                                     |
| T      | A hostile actor tricks the adapter into sending a forged/replayed request to EA                                                                            | Not applicable by construction — adapter never forges a request; `act()` only ever drives the web app's own service-layer functions (instruction 1), so there is nothing to "replay" server-side                                                                       |
| I      | The adapter leaks EA session token / club / trade-history data out of the MAIN world                                                                       | `trimAuction` is the sole privacy seam — only listed, allow-listed fields ever cross into `postMessage`; everything else (session token, full auction/club payloads) stays in MAIN-world scope and is never referenced by anything that serializes across the boundary |
| D      | A malformed/huge EA response crashes the passive observation pipeline                                                                                      | Parse failures increment `failed` counters and are reported via the `shape`/`probe` messages, never thrown uncaught into the page's own script context                                                                                                                 |

### 3.2 Extension — ISOLATED world (`content/`, engine/governor/ranker/assist/autobuyer)

| STRIDE | Threat                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | A message purporting to be from `adapter.ts` (MAIN world) or the background SW is actually from elsewhere | Same `event.source` check as 3.1 for the adapter channel; `sender.id !== browser.runtime.id` check (new, this pass) on every `runtime.onMessage` from background's perspective — see 3.3                                                                                                                                                                                                                  |
| T      | A malformed/hostile runtime message payload (content → background) corrupts handler state                 | `backgroundMessageEnvelopeSchema` validates the envelope; `updateUserSettingsRequestSchema` validates the one currently-highest-risk payload (`settings.set`); every handler is `async`, so any remaining unvalidated-payload `TypeError` still becomes a caught rejection, never an uncaught SW crash. See docs/09-security.md "Open findings" for extending payload schemas to the rest of the handlers |
| E      | The autobuyer engine (`ledger-auto` build only) takes an action the governor would have refused           | Every `engine/autobuyer.ts` call path is gated through `engine/governor.ts`'s `allow(action)` — actions/hour, session length, buy-to-search ratio, coin-flow shape, hard stop, server-pushed kill switch; the listable `ledger` build tree-shakes `autobuyer.ts` out entirely (verified in CI: `grep -rl autobuyer dist/ledger` must be empty)                                                            |
| D      | The engine loop runs away (excessive actions/requests)                                                    | Governor's actions/hour + cooldown-after-hard-stop limits bound this at the extension level, independent of and in addition to the API's own rate limits                                                                                                                                                                                                                                                  |
| R      | No record of what the governor did/why, for later dispute or debugging                                    | Every governor decision is logged locally and summarised to `risk_budget_events` server-side (visible to the user and to admins)                                                                                                                                                                                                                                                                          |

### 3.3 Extension — Service Worker (`background/`)

| STRIDE | Threat                                                                                                      | Mitigation                                                                                                                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Another extension or a compromised page sends a message this listener acts on                               | `sender.id !== browser.runtime.id` check (this pass); no `externally_connectable` manifest key declared, so in practice unreachable from outside this extension anyway — the sender check is defense in depth against that assumption changing                            |
| T      | A malformed runtime message payload                                                                         | `backgroundMessageEnvelopeSchema` + per-type payload schema (§3.2); minimal-permissions manifest (`storage`, `unlimitedStorage`, `alarms` only — no `tabs`, no `<all_urls>`) bounds what a compromised handler could even reach                                           |
| I      | Access/refresh tokens exfiltrated from extension storage                                                    | Access token in `storage.session` (memory-backed, cleared on browser close, never written to disk); refresh token in `storage.local`, encrypted at rest client-side. Error reports are scrubbed of PII before `errors.report` ever leaves the SW (`background/errors.ts`) |
| I      | `console.log`/error reports leak secrets or PII                                                             | `lib/logger.ts`'s ring buffer and `errors.report` payload are built from structured, allow-listed fields — never a raw exception object that might embed a token or the user's email in a stack string                                                                    |
| D      | MV3 kills the SW mid-flow (by design, ~30s idle)                                                            | No engine/governor/ranker state lives in the SW (rule 4) — it re-bootstraps from `storage.session`/`storage.local`/a fresh `bootstrap()` call on every wake; nothing is lost that a heartbeat/settings-sync wouldn't recover                                              |
| E      | A crafted message tries to invoke an admin-only or privileged server action through the SW's bearer session | The SW only ever calls the extension's own user-scoped API surface (`bootstrap`, `heartbeat`, `activity`, etc.); there is no admin token or admin-scoped credential anywhere in the extension                                                                             |

### 3.4 apps/api (REST)

| STRIDE | Threat                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Credential stuffing / brute force against login                            | DB-backed lockout (5 failures → exponential backoff, `lib/lockout.ts`) + Redis sliding-window rate limit, both per-account and per-IP independently                                                                                                                                                                                                                                    |
| S      | Session/token theft (XSS, stolen device, MITM)                             | Dashboard: httpOnly, `secure` (prod), `sameSite=lax` cookies — JS never reads the access/refresh token. Extension: bearer token in `storage.session`/encrypted `storage.local` (§3.3). Refresh token bound to device fingerprint + UA family (`docs/04-auth.md`); reuse of a superseded refresh token revokes the whole session family                                                 |
| T      | Mass assignment — an extra field in a request body silently applied        | Every request-body zod schema is `.strict()` (unrecognised key → 400 `VALIDATION_FAILED`, never silently dropped or applied) — `tests/security/src/mass-assignment.test.ts`, `packages/shared/test/strictness.test.ts`                                                                                                                                                                 |
| T      | SQL injection                                                              | Every query goes through Drizzle's query builder or `sql.raw()` fed a **constant** string + bound params — never `sql` template interpolation. Enforced three ways: ESLint (`no-restricted-syntax`, `packages/config/eslint-preset.js`), semgrep (`.github/semgrep/rules.yml`'s `no-raw-sql-string-interpolation`), and runtime payload tests (`tests/security/src/injection.test.ts`) |
| T      | CSRF against a cookie-session mutation                                     | Double-submit cookie (`sl_csrf`, signed, compared byte-for-byte against `x-csrf-token`) on every cookie-session mutating route; bearer sessions (extension) are exempt by construction (a cross-site request cannot set a custom `Authorization` header) — `docs/04-auth.md` §10, `tests/security/src/csrf.test.ts`                                                                    |
| R      | An admin mutation happens with no record of who/what/when                  | Every admin mutation route calls `recordAudit` (before/after JSONB diff, actor, IP, UA, request id); `audit_logs` is append-only (`REVOKE UPDATE/DELETE` at the DB level)                                                                                                                                                                                                              |
| I      | Verbose error responses leak internals (stack traces, query text)          | Global error handler renders exactly `{code, message, details?, requestId}` — never a raw stack to the client; pino redacts `password`, `passwordHash`, `refreshToken`, `accessToken`, `totpSecret`, `*.email`, `req.body.token`, `res.headers["set-cookie"]` from structured logs (`app.ts`)                                                                                          |
| I      | TOTP secrets / license keys / refresh tokens readable from a DB dump       | TOTP secrets: AES-256-GCM, application-layer, key-id-versioned (`lib/crypto.ts`, rotation via `reencryptTotpSecret`); refresh tokens, license keys, password-reset/email-verification tokens: SHA-256/argon2-hashed, never stored plaintext                                                                                                                                            |
| D      | A single IP/account/route hammers the API                                  | Tiered rate limits: global default, tight auth tier, `INGEST_RATE_LIMIT` (extension batch endpoints), `ADMIN_RATE_LIMIT` (admin mutations); health/liveness probes explicitly exempt (`lib/rate-limit-tiers.ts`)                                                                                                                                                                       |
| E      | A `support`/`analyst`/`billing` admin performs a `super_admin`-only action | Every admin route is gated by `requirePermission('<permission>')` against `@sl/shared`'s `PERMISSION_MATRIX` — the single source of truth the dashboard also renders against. Exhaustively tested: `tests/security/src/authz-matrix.test.ts` (every permission-gated route × every role lacking it → 403)                                                                              |
| E      | Password reset / email verification token guessed or reused                | 32-byte random tokens, hashed at rest, single-use (`consumed_at`), short TTL (1h reset / 24h verify); password reset additionally revokes every session                                                                                                                                                                                                                                |

### 3.5 apps/api (WebSocket gateway)

| STRIDE | Threat                                                                       | Mitigation                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | An unauthenticated client opens a WS connection                              | Auth via a short-lived (30s), single-use, Redis-backed ticket (`GETDEL`) — never a long-lived credential in a URL query string; a missing/already-used ticket closes the socket (4400/4401) |
| T      | Ticket replay (reuse the same ticket for a second connection)                | `GETDEL` makes the ticket single-use atomically — a second upgrade attempt with the same ticket always fails                                                                                |
| I      | A user's WS channel receives another user's events                           | Channels are keyed by `user:{id}` server-side at publish time (`fastify.publishToUser`); a socket only ever subscribes to its own authenticated user's channel                              |
| D      | An open WS connection is held open indefinitely / a flood of ticket requests | Ticket issuance goes through the same authenticated-route rate limiting as any other endpoint; idle/broken sockets are cleaned up by the gateway's own heartbeat                            |

### 3.6 Workers (BullMQ jobs)

| STRIDE | Threat                                                                                  | Mitigation                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | A partition-maintenance or retention job drops the wrong table via a crafted identifier | Table/partition names are built from a fixed, code-controlled date format (never external input) before reaching `sql.raw()`; both `sql.raw()` call sites are `# nosemgrep`-annotated and individually reviewed, not blanket-exempted |
| D      | A slow job (analytics rollup, abuse scan) blocks the API's request path                 | Jobs run in a separate process (`worker.ts`), never in the REST/WS process — a slow job adds latency to nothing user-facing                                                                                                           |
| R      | A job silently fails and nobody notices                                                 | BullMQ's own retry/failure tracking + structured logging; `docs/11-devops.md` covers alerting                                                                                                                                         |

### 3.7 Postgres

| STRIDE | Threat                                               | Mitigation                                                                                                                                                                                             |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I      | Network sniffing between the API and the DB          | `sslmode=require` (or stronger) enforced by `config/env.ts`'s production refinement — the process refuses to boot under `NODE_ENV=production` without it                                               |
| I      | A DB backup/dump leaks plaintext secrets             | Nothing sensitive is stored plaintext (see 3.4's "I" row) — a full dump still requires the app's own encryption key (TOTP) or is simply unusable (hashed tokens/passwords) without the original secret |
| T      | Row tampering that later disputes/audit can't detect | `row_version` bumped on every relevant update (also doubles as the token-invalidation mechanism, §3.4); `audit_logs` before/after diff is the source of truth for "what changed and when"              |
| E      | A compromised low-privilege DB role escalates        | Single application DB role in the MVP topology (documented residual risk, §5) — see `docs/11-devops.md` for the role/least-privilege hardening path                                                    |

### 3.8 Redis

| STRIDE | Threat                                                                              | Mitigation                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I      | Network sniffing between the API and Redis                                          | `rediss://` (TLS) enforced by `config/env.ts`'s production refinement, same mechanism as Postgres above                                                       |
| T      | Rate-limit/session state tampered with by a party with Redis access                 | Redis is not exposed publicly (network-boundary control, `docs/11-devops.md`); values stored are opaque tokens/counters, not directly actionable even if read |
| D      | Redis exhaustion (memory, connection count) from a flood of tickets/rate-limit keys | TTLs on every ephemeral key (WS tickets, MFA tickets, rate-limit windows, lockout counters) — nothing accumulates unbounded                                   |

### 3.9 Stripe integration

| STRIDE | Threat                                                                       | Mitigation                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S      | A forged webhook event                                                       | `stripe.webhooks.constructEvent` signature verification on every delivery — a missing or invalid signature (or a misconfigured server) is rejected with a plain 400, never processed, never a 500 that could look like a retry-worthy transient failure to Stripe (`tests/security/src/webhook-signature.test.ts`) |
| R      | The same webhook event processed twice (Stripe's own at-least-once delivery) | `stripe_webhook_events` unique-`event_id` idempotency table — a second delivery of the same event is a no-op (`apps/api/src/modules/payments/__tests__/payments.test.ts`)                                                                                                                                          |
| T      | Open redirect via `successUrl`/`cancelUrl`/`returnUrl`                       | Every caller-supplied redirect target must start with the configured `DASHBOARD_ORIGIN` (`assertDashboardOrigin`) — `tests/security/src/open-redirect.test.ts`                                                                                                                                                     |
| I      | Full card data touches this app's servers                                    | Never — Checkout/Portal are Stripe-hosted; PCI scope stays entirely with Stripe                                                                                                                                                                                                                                    |

### 3.10 Email

| STRIDE | Threat                                                                         | Mitigation                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | XSS via an admin-supplied `reason`/device name interpolated into an HTML email | `escapeHtml()` applied to every value in `emails/templates.ts` that didn't originate from this server's own static strings or `encodeURIComponent`'d URL params |
| S      | Email spoofing of this app's own outbound mail                                 | Operational (SPF/DKIM/DMARC on the sending domain) — `docs/11-devops.md`, not re-litigated here                                                                 |
| I      | A vulnerable mail library used against this app                                | `nodemailer` kept current (`pnpm audit --prod` tracked in `docs/09-security.md`)                                                                                |

### 3.11 Dashboard (trust relationship with the API)

| STRIDE | Threat                                                                                                                                                                                  | Mitigation                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| S/T    | Cross-site request against a logged-in dashboard session                                                                                                                                | CSRF double-submit (3.4); Vercel-served static assets carry `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` (`vercel.json`) |
| E      | The dashboard's own JS is tricked into calling an admin route it has no permission for                                                                                                  | Server-side `requirePermission` is the actual enforcement (3.4) — the dashboard hiding a button is UX, never the security boundary               |
| I      | Cross-site cookie delivery breaks entirely (or, if "fixed" incorrectly, becomes CSRF-exposed) because the dashboard (Vercel) and API are different sites and cookies are `sameSite=lax` | **Known, tracked open item** — see `docs/09-security.md` "Open findings"; owned by the API follow-ups agent (`COOKIE_SAME_SITE` config)          |

### 3.12 CI/CD and Vercel

| STRIDE | Threat                                                               | Mitigation                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T      | A malicious dependency/compromised CI step modifies build output     | `pnpm audit --prod` in CI; lockfile committed; reproducible builds documented (`docs/11-devops.md`)                                                                                                    |
| I      | Secrets leaked via CI logs or a committed `.env`                     | `.env` files are gitignored; only `.env.example`/`infra/env/*.example` are committed (no real secrets); repo-wide secret grep is part of the security review (`docs/09-security.md` "Secrets hygiene") |
| D      | A compromised/misconfigured Vercel deploy serves stale or wrong code | `ignoreCommand`/`buildCommand` scoped to `apps/dashboard` only (`vercel.json`); this is the dashboard's own deployment surface, isolated from the API                                                  |

## 4. Attack vectors — likelihood / impact / mitigation / test reference

| #   | Vector                                                                                           | Likelihood                                          | Impact                                         | Mitigation                                                                                                                                                                                                                                                                                                | Test reference                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Token theft** (XSS, stolen device, log leakage)                                                | Medium                                              | High (account takeover)                        | httpOnly cookies (dashboard); `storage.session`/encrypted `storage.local` (extension); log redaction; short access-token TTL (15m user / 5m admin)                                                                                                                                                        | `tests/security/src/headers.test.ts`, `apps/api/src/lib/__tests__/crypto.test.ts`, `apps/api/src/modules/auth/__tests__/auth.test.ts` ("shorter admin TTL")                         |
| 2   | **Refresh-token replay**                                                                         | Low-Medium                                          | High (persistent account takeover)             | Rotation on every use; reuse of a superseded token revokes the entire session family; binding to device fingerprint + UA family                                                                                                                                                                           | `apps/api/src/modules/auth/__tests__/refresh-binding.test.ts`, `auth.test.ts` ("refresh rotation: ... reuse revokes the family")                                                    |
| 3   | **License sharing** (one key, many devices/users)                                                | Medium                                              | Medium (revenue loss)                          | `max_devices` enforced at login/device-registration; device fingerprint hashing; admin-visible device list with revoke                                                                                                                                                                                    | `apps/api/src/modules/devices/__tests__`, `apps/api/src/modules/licenses/__tests__`                                                                                                 |
| 4   | **Trial abuse** (multi-account, device/IP reuse)                                                 | High                                                | Medium (revenue loss, skewed metrics)          | Denial + `flags` row on: normalised-email reuse (gmail dots/plus), device-fingerprint reuse, shared `stripe_customer_id`, IP/ASN velocity                                                                                                                                                                 | `apps/api/src/modules/subscriptions/__tests__/subscriptions.test.ts` (4 trial-abuse vectors + false-positive avoidance)                                                             |
| 5   | **Webhook forgery** (fake Stripe events)                                                         | Low                                                 | High (fraudulent entitlement grant)            | Real `stripe.webhooks.constructEvent` signature check; idempotent processing                                                                                                                                                                                                                              | `tests/security/src/webhook-signature.test.ts`, `apps/api/src/modules/payments/__tests__/payments.test.ts`                                                                          |
| 6   | **Extension tampering** (repackaged/modified build)                                              | Low-Medium                                          | Medium (bypassed governor, forged telemetry)   | Signed entitlement blob (Ed25519) verified client-side; `update_url` (CWS for `ledger`, self-hosted signed manifest for `ledger-auto`); server-side rate limits/validation don't trust the client's own governor decisions for anything server-enforced                                                   | `apps/extension/test/unit/license-offline-grace.test.ts`                                                                                                                            |
| 7   | **Malicious EA payload into the adapter**                                                        | Medium (EA controls this surface, not this project) | Medium (bad data ingested, or a crash)         | Bundle probe hard-stops on shape mismatch; `trimAuction` only ever extracts a fixed field set — a hostile/malformed payload can produce garbage numbers, never arbitrary code execution or a schema violation past this seam                                                                              | `docs/01-architecture.md` §3.5                                                                                                                                                      |
| 8   | **XSS via user-provided names/settings**                                                         | Medium                                              | Medium-High (session/data theft)               | API: JSON-only responses, nothing rendered server-side beyond escaped emails. Extension: `esc()` applied to every untrusted string before `innerHTML` (popup, options); DOM construction (not `innerHTML`) for chart-like elements in the panel. Dashboard: React's own JSX escaping (UI agent's surface) | `tests/security/src/injection.test.ts` (XSS payload round-trip, never executed server-side); `apps/api/src/lib/__tests__` (email escaping via `emails/templates.ts`'s `escapeHtml`) |
| 9   | **Admin compromise**                                                                             | Low                                                 | Critical (full data access, entitlement fraud) | Mandatory TOTP enrollment for every admin login before any session is issued; shorter (5m) admin access-token TTL; permission-matrix least-privilege per role; every admin action audited                                                                                                                 | `apps/api/src/modules/auth/__tests__/auth.test.ts` (admin 2FA enrollment flow), `tests/security/src/authz-matrix.test.ts`                                                           |
| 10  | **Insider misuse** (a legitimate admin overreaching their role, or acting maliciously within it) | Low                                                 | High                                           | Permission matrix bounds _what_ any given role can do; append-only `audit_logs` (before/after diff, actor, IP) bounds _accountability_ for what a `super_admin` does even though nothing technical stops them                                                                                             | `apps/api/src/modules/admin-*/__tests__` (`recordAudit` called on every mutation — grep-verified)                                                                                   |
| 11  | **Supply chain** (compromised/vulnerable npm dependency)                                         | Medium                                              | Variable (up to critical)                      | `pnpm audit --prod` tracked in `docs/09-security.md`; lockfile committed; no `eval`/`new Function` anywhere (enforced by semgrep)                                                                                                                                                                         | `.github/semgrep/rules.yml` (`no-eval-or-function-constructor`), `docs/09-security.md` "Dependency audit"                                                                           |
| 12  | **Ingest DoS** (extension batch endpoints flooded)                                               | Medium                                              | Medium (availability, cost)                    | `INGEST_RATE_LIMIT` tier (120/60s) independent of the global default; batch size caps (200-500 items) on every ingest schema                                                                                                                                                                              | `apps/api/src/test/qa/__tests__/rate-limit-tiers.test.ts`                                                                                                                           |
| 13  | **P&L / trading data exfiltration** (IDOR)                                                       | Medium                                              | High (competitive/privacy harm)                | Every own-scoped route (`devices`, `sessions`, `filters`, `trades`) filters by `eq(<table>.userId, request.authUser.id)` — never trusts a client-supplied user id                                                                                                                                         | `tests/security/src/idor.test.ts`                                                                                                                                                   |
| 14  | **Account takeover via password reset**                                                          | Low-Medium                                          | High                                           | Single-use, hashed, 1h-TTL reset tokens; reset revokes every existing session (kills any attacker session that predates the legitimate reset)                                                                                                                                                             | `apps/api/src/modules/auth/__tests__/auth.test.ts` ("password reset revokes all sessions")                                                                                          |
| 15  | **WS ticket theft** (URL/referrer leakage, logging)                                              | Low                                                 | Medium (one-time channel eavesdrop)            | 30s TTL, single-use (`GETDEL`), never a long-lived credential; even a stolen ticket is worthless after first use or 30s                                                                                                                                                                                   | `apps/api/src/modules/ws/__tests__/ws.test.ts`                                                                                                                                      |
| 16  | **Redis/Postgres direct exposure**                                                               | Low (network-boundary control)                      | Critical if it occurred                        | Not publicly bound in the documented deployment topology (`docs/11-devops.md`); TLS enforced by env schema in production regardless                                                                                                                                                                       | `apps/api/src/config/__tests__/env.test.ts`                                                                                                                                         |
| 17  | **Backup leakage**                                                                               | Low                                                 | High                                           | No plaintext secrets in the DB to begin with (3.7); backup handling/encryption is an operational control (`docs/11-devops.md`)                                                                                                                                                                            | — (operational, not app-layer testable)                                                                                                                                             |

## 5. Residual risks

Risks knowingly accepted or only partially mitigated at this pass, in
addition to the "Open findings" list in `docs/09-security.md` (which is the
authoritative, currently-open list with proposed diffs):

- **Single DB role.** The MVP topology uses one Postgres role for the whole
  API process rather than per-module least-privilege roles. Acceptable for
  the MVP's threat model (the main defense against SQLi is parameterisation,
  not role separation); a defense-in-depth improvement for later.
- **`trustProxy: true` (unconditional).** Correct behind the documented
  single-VM Caddy topology (one trusted reverse proxy), but is a blanket
  trust rather than a pinned proxy count/CIDR. Low risk in the current
  deployment shape; worth tightening if the topology grows additional
  hops.
- **Extension runtime-message validation is not yet exhaustive.** Only
  `settings.set` has a dedicated payload schema beyond the envelope check;
  every other handler relies on the envelope check + the "any thrown error
  becomes a caught rejection" safety net rather than a full payload schema.
  See `docs/09-security.md` "Open findings" for the exact extension.
- **No WAF/ZAP baseline scan wired into CI yet** (mentioned as an optional
  job in the original plan) — `pnpm audit` + semgrep + this test suite are
  the current automated coverage; a DAST pass is a reasonable later
  addition, not a gap this pass silently ignored.
- **Geo/ASN enrichment defaults to no-op.** `GEOIP_PROVIDER` defaults to
  `noop` (no bundled/downloaded database, by design) — impossible-travel
  and new-country detection only activate once an operator configures
  MaxMind or ipinfo. Until then, that specific signal is unavailable (not
  silently wrong — a null country never raises a false flag).
- **Cross-site cookie (`SameSite`) for the Vercel-hosted dashboard.** Tracked
  explicitly, not silently deferred — see `docs/09-security.md` "Open
  findings" and §3.11 above.

## 6. Non-goals (explicit)

Restated from the project instructions (`docs/01-architecture.md`'s
"Project instructions", point 2) because a threat model is exactly the
place a scope boundary like this needs to be unambiguous:

- **No CAPTCHA bypass, no client-impersonation/spoofing of any kind.** Not
  built, not documented as a mitigation anywhere in this file, not planned.
  Nothing in this codebase lifts an EA session header for a forged request,
  fakes a browser fingerprint to evade detection, or automates around a
  human-verification challenge. The "safety governor" (§3.2) exists to make
  the extension's own automated actions look and behave like a careful
  human, not to evade EA's anti-automation measures — the project's own
  stance is "we stop you before you look like a bot," never "undetectable."
- **No cross-user pooling of market observations** (raw listings stay
  local, §2) — this is a privacy/trust decision, not merely a security
  control, and is out of scope to "fix" by centralising in a future pass
  without a separate, explicit product decision.
- **Live validation against EA's real web app is out of scope** for this
  document and this pass — the market is not unlocked yet; everything here
  is verified against fixtures/mocks per `docs/01-architecture.md`.
- **Chrome Web Store review/policy compliance** is a distribution concern,
  not a security threat this model tracks (though the `ledger`/`ledger-auto`
  split exists partly because of it — see §3.2's "E" row).
