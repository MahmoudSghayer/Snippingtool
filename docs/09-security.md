# 09 — Security

Controls inventory for The Sniper's Ledger, mapped to code and tests.
Companion documents: `docs/threat-model.md` (STRIDE decomposition, attack
vectors, residual risks, non-goals — read that first for _why_; this
document is _where and how_), `docs/01-architecture.md` §5 (trust-boundary
table), `docs/11-devops.md` (secrets management, TLS/network topology,
backups, CI security jobs).

## Contents

1. Input validation
2. SQL injection prevention
3. XSS
4. CSRF
5. Rate limiting
6. IP monitoring
7. Session security
8. Secure headers
9. Encryption at rest
10. Encryption in transit
11. Secrets hygiene
12. Audit coverage
13. Extension security
14. Stripe webhook review
15. Dependency audit
16. Logging and redaction
17. Incident response basics
18. Open findings
19. Verification commands

---

## 1. Input validation

Every request body, in every module, is a **zod schema with `.strict()`** —
an unrecognised key is a 400 `VALIDATION_FAILED`, never silently dropped or
applied (mass-assignment defence). Pagination is cursor-based with a hard
cap (`paginationQuerySchema`, `limit` max 200); every batch-ingest endpoint
caps array length (200–500 depending on the endpoint) and every free-text
field has an explicit `.max()`.

- Schemas: `packages/shared/src/schemas/*.ts` (one file per domain).
- Cross-cutting proof, not just per-schema unit tests:
  `packages/shared/test/strictness.test.ts` (every `.strict()` schema
  actually rejects an unknown key; every `.max()`-bounded array/string
  actually rejects an oversize input) and
  `tests/security/src/mass-assignment.test.ts` (the same property, driven
  through the real running app's HTTP surface, not just the schema in
  isolation).
- **Fixed this pass:** `activityIngestBatchSchema`
  (`packages/shared/src/schemas/activity.ts`) was the one batch-ingest
  envelope that was not `.strict()` — every sibling envelope already was.
  `.strict()` was added to it and to every per-event `metadata` object;
  `packages/shared/test/strictness.test.ts` and
  `tests/security/src/mass-assignment.test.ts` both cover it now.
- Route wiring: `apps/api/src/app.ts` sets `ajv: { customOptions:
{ removeAdditional: false } }` — a request that fails validation 400s, it
  is never silently coerced into something the schema would have accepted.

## 2. SQL injection prevention

Every query goes through Drizzle's query builder, or `sql.raw()` fed a
**constant** string plus separately-bound parameters — never a `sql`
tagged template with an interpolated runtime value. Enforced three
independent ways, deliberately redundant (a future contributor under time
pressure only has to fail to notice one of three):

1. **ESLint** — `packages/config/eslint-preset.js`'s `no-restricted-syntax`
   rule (`noSqlTemplateInterpolation`) forbids
   `` sql`...${x}...` `` anywhere in the codebase. Runs in every package's
   `lint` script.
2. **Semgrep** — `.github/semgrep/rules.yml`'s `no-raw-sql-string-
interpolation` rule (same pattern, different tool, catches anything the
   TS-aware ESLint rule might miss) — run in CI's `security-scan` job
   (`docs/11-devops.md`).
3. **Runtime payload tests** — `tests/security/src/injection.test.ts`
   sends real SQLi payloads (`'; DROP TABLE users; --`, `' OR '1'='1`,
   `UNION SELECT`, etc.) through real request bodies and asserts the value
   round-trips as inert data (proving parameterisation) and that the
   `users` table is untouched.

The two legitimate `sql.raw()` call sites in the codebase
(`apps/api/src/jobs/partitions.maintain.job.ts`,
`apps/api/src/jobs/audit.retention.job.ts`) build a **partition/table
name** from a fixed, code-controlled date format — never external input —
before handing it to `sql.raw()`, and are individually
`# nosemgrep: no-raw-sql-string-interpolation`-annotated with a comment
explaining why, not blanket-exempted.

## 3. XSS

- **Email templates** (`apps/api/src/emails/templates.ts`): every
  interpolated value that didn't originate from this server's own static
  strings or `encodeURIComponent`'d URL params goes through `escapeHtml()`
  first (an admin-supplied suspension `reason`, a device name from a
  fingerprint the extension/attacker controls).
- **Extension UI**: `esc()` (HTML-entity escaping) is applied to every
  untrusted string before it reaches `innerHTML` in `popup/main.ts` and
  `options/main.ts` (filter names, plan/license text sourced from the
  API). The panel (`ui/panel.ts`) builds price-history/session-P&L
  elements via DOM construction (`createElement`/`textContent`), not
  `innerHTML`, for exactly the same reason.
- **API responses**: JSON only, nothing server-rendered — the API itself
  has no HTML-injection surface of its own to defend; XSS risk is entirely
  at the two render points above plus the dashboard (React's JSX escaping,
  owned by the UI agent, `packages/ui`/`apps/dashboard`).
- **Manifest CSP**: `apps/extension/scripts/generate-manifest.mjs`'s
  `content_security_policy.extension_pages` is
  `"script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'"`
  — no `unsafe-inline`, no `unsafe-eval`, no remote script source.
- **API CSP**: `apps/api/src/plugins/security.ts` sets `default-src 'none'`
  and `frame-ancestors 'none'` (the API serves JSON only, never HTML).
- Test reference: `tests/security/src/injection.test.ts` (XSS payloads
  through real request bodies, proving they're stored/returned as inert
  data, never executed); `apps/api/src/lib/__tests__` covers
  `escapeHtml` indirectly through the templates that use it.

## 4. CSRF

Double-submit cookie, for the dashboard's cookie-session flow only — the
extension always authenticates with a bearer `Authorization` header, which
a cross-site request cannot forge (a page cannot set a custom header on a
cross-site form submission), so bearer sessions are exempt by construction.

- Implementation: `apps/api/src/plugins/csrf.ts`. `sl_csrf` is a signed,
  non-httpOnly cookie (so the dashboard's own JS can read it out of
  `document.cookie`); every cookie-session mutation requires an
  `x-csrf-token` header whose value is compared **byte-for-byte** against
  the raw (still-signed) cookie value, constant-time (`timingSafeEqual`).
  Deliberately not `@fastify/csrf-protection`'s secret+derived-token model
  — see the plugin's own header comment for why that model doesn't fit
  this client.
- Applied via `preHandler: [fastify.verifyCsrf]` on every route that
  mutates state under a possible cookie session (devices, sessions,
  filters, payments checkout/portal, settings, etc.) — GET/HEAD/OPTIONS
  never need it.
- Test reference: `tests/security/src/csrf.test.ts` — sets cookies on
  login, rejects a missing token, rejects a forged token, accepts a
  correct token, confirms a bearer call needs none, confirms GET never
  needs one.

## 5. Rate limiting

Tiered, composed (a request is checked against the global default **and**
its route's own tier, not one or the other):

| Tier              | Scope                                                                                                                            | Limit                                                  | Source                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Global default    | Every route (per IP+user, `plugins/rate-limit.ts`)                                                                               | `RATE_LIMIT_GLOBAL_MAX`/`_WINDOW_MS` (300/60s default) | `config/env.ts`                                          |
| Auth (tight)      | `/auth/login`, `/auth/register`, `/auth/mfa/verify`, etc.                                                                        | `RATE_LIMIT_LOGIN_MAX`/`_WINDOW_MS` (20/900s default)  | `modules/auth/index.ts`                                  |
| Ingest (moderate) | Extension batch endpoints (`activity`, `sniping`, `trades`, `filters`, `risk-events`, `extension/telemetry`, `extension/errors`) | `INGEST_RATE_LIMIT` (120/60s)                          | `lib/rate-limit-tiers.ts`                                |
| Admin (moderate)  | Every admin mutation route                                                                                                       | `ADMIN_RATE_LIMIT` (60/60s)                            | `lib/rate-limit-tiers.ts`                                |
| Health (exempt)   | `/health/live`, `/health/ready`                                                                                                  | No limit — infra polls these by design                 | `lib/rate-limit-tiers.ts`'s `HEALTH_EXEMPT_ROUTE_CONFIG` |

Account **lockout** (distinct from rate limiting — protects one account
even from a rotating-IP attacker) is DB-backed:
`users.failed_login_count`/`locked_until`, 5 failures → exponential backoff
(15m, 30m, 60m, ... capped at 24h) — `apps/api/src/lib/lockout.ts`.

429/423 responses render the standard `{code, message, details?,
requestId}` envelope (`RATE_LIMITED`/`AUTH_ACCOUNT_LOCKED`), never a bare
status code with no body.

Test references: `apps/api/src/test/qa/__tests__/rate-limit-tiers.test.ts`
(ingest/admin tiers, health exemption, exact envelope); `apps/api/src/modules/auth/__tests__/auth.test.ts`
("locks the account after 5 failed logins").

## 6. IP monitoring

`ip_activity` (per `(ip, user)` rolling counter: `first_seen`, `last_seen`,
`request_count`, `country`, `asn`, `flagged`) upserted on every successful
login (`apps/api/src/lib/ip-activity.ts`'s `upsertIpActivity`,
best-effort — never blocks or fails the login it's monitoring).

**Pluggable geo/ASN provider** (`apps/api/src/lib/geoip.ts`):

- `NoopGeoIpProvider` — default. Returns "unknown" for everything; no
  database bundled or downloaded, by explicit design. A monitoring feature
  that guesses wrong is worse than one that abstains — a null country
  never raises a false flag, it just skips the check.
- `MaxMindGeoIpProvider` — local `.mmdb` file (never fetched/downloaded by
  this code) via `GEOIP_MAXMIND_DB_PATH`.
- `IpinfoGeoIpProvider` — ipinfo.io HTTP lookup via `IPINFO_TOKEN`.
- Selected by `GEOIP_PROVIDER` (`noop`/`maxmind`/`ipinfo`) — now declared
  in `config/env.ts`'s zod schema (validated + documented, fails fast at
  boot on an unrecognised value) alongside the two credential vars.

**New-country / impossible-travel detection**
(`recordSuspiciousIpIfAny`, same file): compares a fresh login's country
against the user's recent login history; a login from a country not seen
recently raises a `flags` row (`kind: 'suspicious_ip'`), and a different
country seen within `IMPOSSIBLE_TRAVEL_WINDOW_MS` (3h) is flagged at higher
severity as impossible travel. Admins review `flags` at
`/admin/flags`.

Test references: `apps/api/src/modules/auth/__tests__/ip-monitoring.test.ts`.

## 7. Session security

- **Access token**: EdDSA-signed JWT. **15 minutes for a plain user, 5
  minutes for an admin** (added this pass — `lib/tokens.ts`'s
  `accessTokenTtlSeconds(role)`; the cookie's `maxAge` matches the signed
  token's actual TTL exactly, never a hardcoded 15m regardless of role).
  Claims: `sub, sid, did, role, plan, ver`.
- **`ver` vs `users.row_version`**: `ver` mirrors the user's row_version at
  issue time. Any account-affecting write (force logout, password change,
  an admin action) bumps `row_version` via the DB's `bump_row_version`
  trigger; `authenticate` (`plugins/auth.ts`) re-checks the token's `ver`
  claim against the _current_ DB row on every request, so a previously
  issued token is rejected even before its 15-minute expiry.
- **Refresh token**: opaque 32 random bytes, SHA-256-hashed at rest, 30-day
  TTL, rotated on every use. **Bound to device fingerprint + UA family**
  (`modules/auth/service.ts`) — a mismatch is treated exactly like reuse of
  a superseded token: the entire session family is revoked, not just that
  one call denied. Test: `apps/api/src/modules/auth/__tests__/refresh-binding.test.ts`.
- **Reuse detection**: presenting a refresh token that doesn't match the
  current hash for its family (but the family is still valid) is reuse of
  a rotated-away token — revokes the whole family. Test:
  `auth.test.ts` ("refresh rotation: ... reuse revokes the family").
- **Logout-all on password change**: password reset revokes every session
  for that account. Test: `auth.test.ts` ("password reset revokes all
  sessions").
- **Admin 2FA mandatory**: an admin account cannot complete login without
  TOTP enrolled — `login` returns an `mfaTicket` in `enroll` mode and the
  session only completes once enrollment + a valid code are both provided.
  Test: `auth.test.ts` ("2FA: enroll, confirm, then step-up login").
- **Single-use WS tickets**: 30s TTL, Redis `GETDEL` (atomically consumed
  on first use) — `modules/ws/index.ts`. Test: `modules/ws/__tests__/ws.test.ts`.

## 8. Secure headers

`@fastify/helmet` (`apps/api/src/plugins/security.ts`):

| Header                         | Value                                                                  | Notes                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`      | `default-src 'none'; frame-ancestors 'none'`                           | JSON API, nothing to render                                                                                                                                                                                                                         |
| `X-Frame-Options`              | `DENY`                                                                 | Added explicitly this pass — helmet's own default is `SAMEORIGIN`, which is weaker than this API (which has no "same origin" that should ever frame it either) needs; `frameAncestors: 'none'` above is the modern equivalent for CSP-aware clients |
| `X-Content-Type-Options`       | `nosniff`                                                              | helmet default                                                                                                                                                                                                                                      |
| `Referrer-Policy`              | `no-referrer`                                                          | Explicit, not relying on helmet's default staying the same across majors                                                                                                                                                                            |
| `Cross-Origin-Resource-Policy` | `same-site`                                                            |                                                                                                                                                                                                                                                     |
| `Permissions-Policy`           | every feature denied (`camera=(), microphone=(), geolocation=(), ...`) | Hand-set (helmet doesn't ship this directive)                                                                                                                                                                                                       |
| `Strict-Transport-Security`    | `max-age=15552000; includeSubDomains; preload`                         | **Production only** (`NODE_ENV === 'production'`) — never sent in dev/test, so a local run can never poison a browser's HSTS cache for `localhost`                                                                                                  |
| `X-Powered-By`                 | absent                                                                 | Fastify never sets it in the first place (unlike Express)                                                                                                                                                                                           |

Test reference: `tests/security/src/headers.test.ts` — asserts the full
set on a public route, an authenticated route, and an error response
(headers apply on every response, not just 2xx); asserts HSTS is absent
under `NODE_ENV=test`.

The Vercel-hosted dashboard carries its own header set
(`vercel.json`): `X-Content-Type-Options: nosniff`, `X-Frame-Options:
DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.

## 9. Encryption at rest

- **TOTP secrets** (`users.totp_secret_enc`): AES-256-GCM,
  application-layer (not pgcrypto — works identically in tests without a
  DB extension), **key-id-versioned** — `apps/api/src/lib/crypto.ts`.
  - Blob format: `[1-byte key-id length][key-id][12-byte IV][ciphertext][16-byte auth tag]`.
  - `TOTP_ENCRYPTION_KEYS` (JSON map of key-id → key material) +
    `TOTP_ENCRYPTION_ACTIVE_KEY_ID` (default `'v1'`, derived from
    `COOKIE_SECRET` if unset) select the active encryption key.
  - **Rotation helper**: `reencryptTotpSecret(blob, cookieSecret)` decrypts
    under whichever key the blob was written with and re-encrypts under
    the _current_ active key — a no-op if already on the active key. Used
    to migrate existing rows forward after an operator adds a new key id
    and flips the active one.
  - **Rotation procedure**: (1) add the new key id + material to
    `TOTP_ENCRYPTION_KEYS`, (2) deploy, (3) flip
    `TOTP_ENCRYPTION_ACTIVE_KEY_ID` to the new id, (4) new writes use the
    new key immediately, old blobs keep decrypting via the still-present
    old entry, (5) run `reencryptTotpSecret` over existing rows on your own
    schedule, (6) only remove the old key id from the registry once every
    row has been migrated (removing it early makes any un-migrated row
    fail loudly — "unknown key id" — rather than silently, by design).
  - Test coverage: `apps/api/src/lib/__tests__/crypto.test.ts` — round-trip,
    wrong-key rejection, default key-id embedding, rotation (old blobs
    keep decrypting, new writes use the new key), `reencryptTotpSecret`
    migration + idempotency, and "a prematurely-removed key id fails
    loudly, not silently".
- **Hashed, never plaintext**: refresh tokens (SHA-256, `lib/crypto.ts`'s
  `fastHash`), license keys (`licenses.key_hash`, same hash), email-
  verification/password-reset tokens, TOTP recovery codes (argon2-hashed
  via `hashSecret`), user passwords (argon2id).
- **Log redaction test**: `apps/api/src/app.ts`'s pino `redact.paths`
  covers `req.body.token`, `req.body.code`, `res.headers["set-cookie"]`,
  `*.password`, `*.passwordHash`, `*.refreshToken`, `*.accessToken`,
  `*.totpSecret`, `*.email`. See §16 for the dedicated redaction test this
  pass added.

## 10. Encryption in transit

- **Trust proxy**: `apps/api/src/app.ts` sets `trustProxy: true` —
  correct behind the documented single-VM Caddy topology (one trusted
  reverse proxy terminates TLS); see `docs/threat-model.md` §5 for the
  residual-risk note on this being a blanket trust rather than a pinned
  proxy count.
- **Database**: `config/env.ts`'s production refinement (added this pass)
  refuses to boot under `NODE_ENV=production` unless `DATABASE_URL`
  carries `sslmode=require` (or `verify-ca`/`verify-full`) as a query
  param — checked by regex against the connection string; the actual TLS
  handshake is `postgres.js`'s own job (`plugins/db.ts`).
- **Redis**: same production refinement requires `REDIS_URL` to use the
  `rediss://` (TLS) scheme — `ioredis` enables TLS purely from that scheme,
  no extra config needed (`plugins/redis.ts`).
- **Startup refusal of dev defaults in production**: the same refinement
  also refuses to boot in production with the default dev `COOKIE_SECRET`,
  or with `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` or
  `ENTITLEMENT_SIGNING_KEY`/`ENTITLEMENT_PUBLIC_KEY` unset. Every violation
  is reported together (not just the first one hit), so a misconfigured
  deploy gets one clear error listing everything wrong, not a whack-a-mole
  sequence of restarts.
- Test reference: `apps/api/src/config/__tests__/env.test.ts` — a
  fully-configured production env loads cleanly; each of the five checks
  above is individually asserted to fail with a message naming the
  offending var; dev/test are asserted unaffected by any of it; a
  maximally-broken production env reports all five violations in one
  thrown error.
- **Stripe/SMTP**: both are outbound HTTPS/TLS by the nature of their own
  client libraries (Stripe SDK, nodemailer's SMTPS) — no additional app-
  layer control needed beyond keeping those libraries current (§15).
- Caddy auto-TLS for the deployed origin, WAL-G/backup encryption notes:
  `docs/11-devops.md` (operational, not app-layer — not re-documented
  here).

## 11. Secrets hygiene

- No real secret is committed anywhere in this repo — verified by
  `git ls-files | grep -E '\.env$|\.env\.[a-z]+$'` (only `.example` files
  are tracked) and a repo-wide grep for live-looking key patterns
  (`sk_live`, `sk_test` outside test fixtures, AKIA-prefixed AWS keys, PEM
  private-key headers) — every hit found is an obviously-fake test
  placeholder (e.g. `'sk_test_irrelevant_no_network_call_made'`).
- `.env` is gitignored at the repo root; every real environment ships as
  `<app>/.env.example` (safe to commit — empty/placeholder values) or
  `infra/env/.env.<environment>.example` (DevOps-owned).
- Semgrep's `no-hardcoded-secret-const`/`no-hardcoded-secret-property`
  rules (`.github/semgrep/rules.yml`) flag a literal string assigned to a
  secret-looking `const`/property name for manual review in CI.
- **Doppler/SOPS**: `docs/11-devops.md` §"Secrets management" is the
  authoritative pointer for how secrets are meant to be provisioned in a
  real deployment (Doppler for env injection, or SOPS+age/KMS for an
  encrypted-at-rest `.env` committed to a private ops repo) — not
  duplicated here.

## 12. Audit coverage

Every admin mutation route calls `recordAudit` (before/after JSONB diff,
actor, entity, IP, user-agent, request id) — `apps/api/src/lib/audit.ts`.
Verified by grep across every `admin-*` module:

```
$ grep -c "recordAudit" apps/api/src/modules/admin-*/index.ts
admin-activity/index.ts:0     # read-only module, no mutation routes
admin-analytics/index.ts:2
admin-audit/index.ts:0        # read-only module, no mutation routes
admin-bans/index.ts:3
admin-config/index.ts:2
admin-coupons/index.ts:3
admin-flags/index.ts:2
admin-plans/index.ts:4
admin-subscriptions/index.ts:8
admin-system/index.ts:0       # read-only module, no mutation routes
admin-toggles/index.ts:2
admin-users/index.ts:4
```

The three `0`-count modules were individually checked (not just trusted at
face value) — each has zero `POST`/`PATCH`/`PUT`/`DELETE` routes at all
(`grep -n "app\.\(post\|patch\|put\|delete\)("` on each returns nothing),
so `0` is correct, not a gap.

`audit_logs` itself is append-only at the DB level (`REVOKE UPDATE,
DELETE` in its migration) — even a compromised application role cannot
rewrite history, only add to it.

## 13. Extension security

- **Token storage**: access token in `storage.session` (memory-backed,
  cleared on browser close, never touches disk); refresh token in
  `storage.local`, encrypted client-side.
- **postMessage origin checks**: every `window.postMessage` listener
  (`main/adapter.ts`, `content/adapter-client.ts`) checks
  `event.source !== window` (or `!== target`) before processing, and every
  send uses an explicit target origin (`window.location.origin` /
  `target.location.origin`) — never `'*'`.
- **Runtime message validation** (added/extended this pass,
  `background/index.ts`):
  - `sender.id !== browser.runtime.id` is checked first — only ever acts
    on a message this exact extension install sent itself. The manifest
    declares no `externally_connectable`, so in practice this listener is
    already unreachable from outside the extension; this is defense in
    depth against that assumption changing.
  - The envelope (`{type, payload}`) is validated against
    `backgroundMessageEnvelopeSchema` (`@sl/shared`) — an unrecognised
    `type` is silently ignored (left for another listener), matching MV3
    convention, rather than acted on.
  - `settings.set`'s payload is additionally validated against the exact
    same `updateUserSettingsRequestSchema` the server validates it
    against, so the two can never drift.
  - Every handler is `async`, so a `TypeError` from a still-unvalidated
    payload shape always becomes a caught rejection (`{ok: false, error}`)
    inside the listener's own `.catch`, never an uncaught exception in the
    service worker. See §18 for extending per-type payload schemas to the
    remaining handlers.
- **No eval, no remote code**: `.github/semgrep/rules.yml`'s
  `no-eval-or-function-constructor` rule (repo-wide, includes
  `apps/extension`); manifest CSP (§3) has no `unsafe-eval` and
  `script-src 'self'` only — nothing outside the packaged bundle can ever
  execute as script.
- **Minimal permissions**: `permissions: ['storage', 'unlimitedStorage',
'alarms']` only — no `tabs`, no `scripting`, no `<all_urls>`.
  `host_permissions` is exactly the EA web-app origins plus this project's
  own API origin (`generate-manifest.mjs`) — nothing else is reachable.
- **Error reports scrubbed of PII**: `background/errors.ts`'s
  `errors.report` payload is built from structured, allow-listed fields
  (error code, message, context) — never a raw exception object that
  might embed the user's email or a token in a stack string.
- **`update_url` https**: the listable `ledger` build has no `update_url`
  (Chrome Web Store owns its updates); the self-hosted `ledger-auto` build
  sets `update_url` only when `EXTENSION_UPDATE_URL` is configured, and
  every deployment-documented value for it is an `https://` URL
  (`docs/06-extension.md`, `docs/11-devops.md`).
- **No CAPTCHA bypass, no client spoofing** — restated explicitly here as
  well as in the threat model: nothing in `apps/extension/**` lifts an EA
  session header for a forged request, spoofs a browser fingerprint, or
  automates around a human-verification challenge. The governor
  (`engine/governor.ts`) exists to keep the extension's _own_ automated
  actions within a human-plausible envelope, not to evade EA's own
  anti-automation detection — see `docs/threat-model.md` §6.

## 14. Stripe webhook signature/replay/idempotency review

- **Signature**: `stripe.webhooks.constructEvent(rawBody, signature,
webhookSecret)` — the real Stripe SDK's own HMAC verification, not a
  hand-rolled check. A missing `stripe-signature` header, a forged one, or
  a misconfigured server (Stripe env vars unset) are now **uniformly** a
  400 with the standard `{code: 'VALIDATION_FAILED', message,
requestId}` envelope (`apps/api/src/modules/payments/index.ts`) —
  **fixed this pass**: the route previously declared its own bespoke
  `400: {received: boolean}` response schema and `reply.status(400)
.send({received: false})`-ed manually on a bad signature, while the
  _missing-header_ check a few lines above it already `throw`s an
  `AppError`. That mismatch meant the app-wide error envelope (rendered by
  `plugins/error-handler.ts` for the thrown case) got validated against a
  schema that only allows `{received: boolean}` and failed zod response
  serialization — turning a clean, intended 400 into an actual 500. Both
  paths now `throw AppErrors.validation(...)` uniformly, and the route
  declares only its success (`200`) shape.
- A closely related, independently-discovered bug was fixed alongside it:
  `apps/api/src/lib/errors.ts`'s `isAppError()` relied on `instanceof
AppError` alone, which returns `false` when a module-loading setup ends
  up with two distinct `AppError` class objects for the same compiled file
  (observed with `tests/security`, which loads the built `@sl/api/app`
  through Vitest's own module runner) — silently routing an intended 4xx
  through the generic 500 "Unhandled error" branch. `isAppError` now falls
  back to a structural check (`name === 'AppError'` plus the exact
  `status`/`code` shape only this class's constructor ever produces) when
  `instanceof` doesn't already confirm it.
- **Replay/idempotency**: `stripe_webhook_events` has a unique constraint
  on `event_id` — `receiveWebhookEvent` checks it before processing and is
  a no-op on a second delivery of the same event, covering Stripe's own
  at-least-once delivery semantics.
- **Raw body**: the webhook route overrides its content-type parser
  (`parseAs: 'buffer'`) scoped to just that nested route registration, so
  signature verification runs against the exact bytes Stripe signed — the
  app-wide JSON parser (which would reformat/re-serialize the body) never
  touches this route.
- Test references: `apps/api/src/modules/payments/__tests__/payments.test.ts`
  (signature rejection, idempotent double-delivery, and every webhook
  event type's business-logic effect); `tests/security/src/webhook-signature.test.ts`
  (missing header, forged signature, no partial DB write on rejection,
  publicly reachable with no auth header required).

## 15. Dependency audit

`pnpm audit --prod`, run against the whole workspace:

**Before this pass:** 1 low, 8 moderate, 4 high, 0 critical — all 12 in
`nodemailer` (six/seven distinct advisories, `apps/api`'s transitive
dependency) plus 1 high in `drizzle-orm`.

**Fixed this pass:** `nodemailer` bumped `^6.10.0` → `^10.0.10`
(`@types/nodemailer` `^6.4.17` → `^8.0.2`) — clears every nodemailer
advisory. Verified: `apps/api` typecheck/lint/test (including the mailer-
backed auth flows: register→verify, password reset, device-limit warning
emails) all green after the bump; `tests/security` (which boots the real
built app, mailer included) still 167/167 green.

**After the security pass, before the API follow-ups pass:** 0 low, 0
moderate, **1 high**, 0 critical (`drizzle-orm`).

**Resolved (API follow-ups pass):** `drizzle-orm` `^0.38.3` → `^0.45.2`
(SQL-injection-via-improperly-escaped-identifiers advisory, closed by
`pnpm audit --prod` — now **0 low, 0 moderate, 0 high, 0 critical**), bumped
identically across all three packages that pin it (`packages/db`,
`apps/api`, `tests/security`) via `pnpm add --filter <pkg> drizzle-orm@latest`,
in that order followed by `pnpm --filter @sl/db test && pnpm --filter
@sl/api test && pnpm --filter @sl/security-tests test` — all green
(`@sl/db` 10 files/66 tests, `@sl/api` 33 files/165 tests, `@sl/security-tests`
10 files/167 tests, including the extended authz matrix, §"Open findings"
below). Two behaviour changes the bump surfaced, both fixed:

1. **`@sl/db`'s `soft-delete.test.ts`**: 0.45's Postgres driver wraps every
   query error in a `DrizzleQueryError`, whose own `.message` is the failed
   SQL text, not the driver's error message — the original `postgres`
   error (with the "duplicate key"/constraint-name text these two tests
   assert on) moved to `.cause`. Fixed by asserting against
   `rejects.toMatchObject({ cause: { message: /duplicate key|unique
constraint/i } })` instead of `rejects.toThrow(...)` on the wrapper's
   own message.
2. **`apps/api`'s `payments/webhooks.ts#receiveWebhookEvent`**: its
   idempotency check read `(err as { code?: string }).code === '23505'`
   directly off the caught insert error — the same wrapping as above means
   `err.code` is now `undefined`; the Postgres error code moved to
   `err.cause.code`. Fixed to check both (`err.code ?? err.cause?.code`),
   confirmed against `payments.test.ts`'s two idempotent-delivery tests
   (previously green under 0.38, both real regressions this bump would
   otherwise have introduced silently — a redelivered Stripe webhook event
   would have thrown instead of returning `{ alreadyProcessed: true }`,
   since the changed `.code` shape meant it fell through to `throw err`).

This codebase's own mitigation against the _specific_ advisory class
(improperly-escaped SQL identifiers) was already independent of the
library-level fix and remains true post-bump: no code path in this repo
builds a Drizzle identifier from untrusted input (§2) — the two
`sql.raw()` call sites use a fixed date-format-derived table name, never
anything a request body supplies.

## 16. Logging and redaction

- Structured logging via pino (`apps/api/src/app.ts`), `redact.paths`
  covering every field listed in §9.
- Request id (`x-request-id` header, or a generated UUID) on every
  request/response and in every error envelope — the correlation key for
  tracing one request across logs without needing to log its body.
- Error responses never include a stack trace or raw exception message to
  the client (§1's error-handler summary in `docs/threat-model.md` §3.4).

## 17. Incident response basics

- **Force logout** (admin action): revokes every session for a user, bumps
  `row_version` (invalidating any already-issued access token immediately,
  not just at its 15-minute expiry), and pushes a WS `force-logout` event
  so an active dashboard/extension session is kicked out in near-real-time
  rather than waiting for its next API call to discover the revocation.
- **Kill switch**: a feature-toggle-driven flag the extension checks on
  every heartbeat; flipping it halts every automated action extension-wide
  within one heartbeat interval, independent of any per-account action.
- **Account lockout / ban**: `bans` (account/IP/device/hwid) +
  `users.status` (suspended/banned) — both checked at `authenticate`, so a
  banned account's existing, still-technically-valid tokens stop working
  immediately, not just at next login.
- **Audit trail**: every admin action (including all of the above) is in
  `audit_logs` with a before/after diff, for after-the-fact review.
- **Webhook/Stripe incident**: `stripe_webhook_events` + `payment_history`
  give a complete, append-only record of every event this app received
  and how it was processed, for reconciling against Stripe's own
  dashboard if state ever diverges.
- Escalation/on-call/alerting process itself is operational, not app-code
  — `docs/11-devops.md` (monitoring/alerting stack).

## 18. Open findings

Findings #1–#3 below were closed by the **API follow-ups pass**; kept here
(marked **Resolved**) rather than deleted, both as a record of the fix and
because other docs (`docs/07-dashboard.md` §11) cross-reference them by
number. #4–#5 remain open, as before.

1. **Resolved — cross-site cookie `SameSite` for the Vercel-hosted
   dashboard.** `sl_at`/`sl_rt`/`sl_csrf` were all hardcoded
   `sameSite: 'lax'`. Fixed exactly as this section previously proposed:
   `COOKIE_SAME_SITE` (`lax` default \| `strict` \| `none`) and
   `COOKIE_SECURE` env vars (`apps/api/src/config/env.ts`), applied via a
   shared `resolveCookieAttrs()` helper (`apps/api/src/lib/cookie-options.ts`)
   in both `modules/auth/index.ts` (`setSessionCookies`) and
   `plugins/csrf.ts`. `sameSite: 'none'` always forces `secure: true`
   regardless of `COOKIE_SECURE`/`NODE_ENV` (spec requirement); a
   production refinement in `env.ts` refuses to boot with
   `COOKIE_SAME_SITE=none` unless `COOKIE_SECURE=true` and both
   `APP_ORIGIN`/`DASHBOARD_ORIGIN` are `https://`. Test coverage:
   `modules/auth/__tests__/cookie-attrs.test.ts` (two full app builds —
   default `lax` and cross-site `none`+`COOKIE_SECURE=true` — asserting
   the real `Set-Cookie` attributes on all three cookies) and
   `config/__tests__/env.test.ts`'s three new production-refusal cases.
   Full detail: [`04-auth.md` §10.1](./04-auth.md#101-cookie-samesitesecure-cross-site-dashboard-deployments),
   [`07-dashboard.md` §5](./07-dashboard.md#5-authcsrf-across-origins-deployment),
   [`11-devops.md` §6](./11-devops.md#6-cors-cookies-and-the-vercel-dashboard).

2. **Resolved — `drizzle-orm` dependency advisory.** Bumped `^0.38.3` →
   `^0.45.2` across all three packages that pin it; `pnpm audit --prod` is
   now clean (0 findings, was 1 high). Two behaviour changes the bump
   surfaced were fixed (a test assertion, and a real bug in the Stripe
   webhook idempotency check's error-code detection) — see §15 for full
   detail.

3. **Resolved — extension runtime-message payload validation was not
   exhaustive.** Every `background/index.ts` handler that takes a payload
   now has a dedicated `@sl/shared` schema in its `payloadSchemas` map —
   either the exact matching server-side request/DTO schema
   (`auth.mfa` → `mfaVerifyRequestSchema`, `settings.set` →
   `updateUserSettingsRequestSchema`) or a purpose-built
   `extBackground*PayloadSchema` (`packages/shared/src/ext-messages.ts`)
   where the shape genuinely differs, exactly as this section previously
   flagged (`auth.login`/`auth.register` carry no `device` field — the
   fingerprint is computed inside `background/auth.ts` itself). Covers
   `record`, `summary`, `auth.login`, `auth.register`, `auth.mfa`,
   `auth.logout`, `license.heartbeat`, `settings.set`, `filters.save`, and
   `telemetry.enqueue` (a discriminated union over its six queue kinds).
   Every new payload schema is `.strict()` with `.max()`-bounded arrays,
   matching this codebase's mass-assignment convention (§1). A handler
   with no payload (`auth.refresh`/`.status`, `license.bootstrap`,
   `settings.get`, `filters.list`, `devices.list`, `logs.export`,
   `telemetry.flush`, `errors.report`, `engine.state`, `counts`) has
   nothing to validate and is deliberately left out of the map.
   **Build-safety note**: the `event`-kind item schema is a small
   deliberate _duplicate_ of `schemas/extension.ts`'s `telemetryEventSchema`
   rather than an import of it — that module also builds
   `bootstrapResponseSchema`, which references `FEATURE_KEYS` (a plan
   feature-gate vocabulary that includes the literal string
   `'automation.autobuyer'`). Importing `telemetryEventSchema` at runtime
   pulled that whole module — including the `'automation.autobuyer'`
   string — into the listable build's background service-worker bundle
   (`apps/extension/dist/ledger/background.js`), confirmed empirically (the
   bundler didn't tree-shake the unused sibling export away) and caught by
   this repo's own build check (`grep -rl autobuyer apps/extension/dist/ledger`
   must print nothing, §19/rule 5 — "Automation ships as a separate
   build"). The 4-line duplicate schema avoids the whole-module import
   entirely; verified fixed (background.js shrank ~31KB → ~26KB, and the
   grep now finds nothing).

4. **No DAST/ZAP baseline scan wired into CI.** Optional per the original
   plan; `pnpm audit` + semgrep + this test suite are the current
   automated coverage. Reasonable later addition, not a silent gap —
   tracked in `docs/threat-model.md` §5.

5. **Single Postgres role, blanket `trustProxy: true`.** Both documented
   as accepted residual risk for the MVP topology, not "found but
   unfixed" — see `docs/threat-model.md` §5 for the reasoning.

## 19. Verification commands

```bash
# Full hardening verification, in the order this pass ran them:
pnpm --filter @sl/api typecheck && pnpm --filter @sl/api lint
NODE_ENV=test TEST_DATABASE_URL=postgres://sl:sl@127.0.0.1:5432/sniper_ledger_test_security \
  REDIS_TEST_DB=13 pnpm --filter @sl/api test

pnpm --filter @sl/shared typecheck && pnpm --filter @sl/shared lint && pnpm --filter @sl/shared test

pnpm --filter @sl/extension typecheck && pnpm --filter @sl/extension lint \
  && pnpm --filter @sl/extension test && pnpm --filter @sl/extension build
grep -rl autobuyer apps/extension/dist/ledger   # must print nothing

# tests/security imports the *built* @sl/api (via its `exports["./app"]` ->
# dist/app.js) — build it and its workspace deps first:
pnpm exec turbo run build --filter=@sl/api...
NODE_ENV=test TEST_DATABASE_URL=postgres://sl:sl@127.0.0.1:5432/sniper_ledger_test_security \
  REDIS_TEST_DB=13 pnpm --filter @sl/security-tests test

pnpm audit --prod
pnpm --filter @sl/api openapi   # regenerate apps/api/openapi/openapi.json after a schema change
```

**Results as of the security pass:** `@sl/api` — 32 test files / 160 tests
green (typecheck/lint clean); `@sl/shared` — 11 files / 140 tests green;
`@sl/extension` — 10 files / 74 tests green, build produces a loadable
`dist/ledger` + `dist/ledger-auto` with zero `autobuyer` references in the
listable build; `@sl/security-tests` — 10 files / 167 tests green (up from
the 4 files / 125 tests a previous wave reported — this pass completed the
remaining six suites: IDOR, injection payloads, security headers, open
redirect, mass assignment, webhook signature). `pnpm audit --prod` — 0
critical, 1 high (see §15).

**Results as of the API follow-ups pass** (§18 findings #1–#3, the
`drizzle-orm` bump, and the new routes in `docs/03-api.md`/
`docs/07-dashboard.md` §11): `@sl/api` — **33 test files / 165 tests**
green (typecheck/lint clean; +1 file/+5 tests: `cookie-attrs.test.ts`, plus
3 new `env.test.ts` cases folded into the existing file's count);
`@sl/shared` — 11 files / 140 tests green; `@sl/db` — 10 files / 66 tests
green; `@sl/extension` — 10 files / 74 tests green, build still produces a
loadable `dist/ledger` + `dist/ledger-auto` with zero `autobuyer`
references (re-verified after the `ext-messages.ts` payload-schema
additions — see finding #3's build-safety note); `@sl/security-tests` —
10 files / **167 tests** green (`authz-matrix.test.ts` grew from 48 to 51
cases: the three new admin routes, `GET /admin/subscriptions`, `GET
/admin/subscriptions/by-user/:userId` — both `subscriptions.read`, closing
that permission's prior `KNOWN_UNENFORCED_PERMISSIONS` entry — and `GET
/admin/users/:id/risk-events`, `users.read`). `pnpm audit --prod` — **0
findings** (down from 1 high — the `drizzle-orm` bump, §15).
