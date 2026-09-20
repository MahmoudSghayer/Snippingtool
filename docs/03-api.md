# 03 — API

Status: implementation-ready for the modules this document covers (every
`apps/api/src/modules/**` folder *except*
`{subscriptions,licenses,payments,coupons,plans,bans,flags}` and their
`admin-*` counterparts, which are documented in
[`05-subscriptions.md`](./05-subscriptions.md) by the agent that owns them).
Read [`01-architecture.md`](./01-architecture.md) first for the system-level
picture and [`02-database.md`](./02-database.md) for the schema every route
below reads or writes. Read [`04-auth.md`](./04-auth.md) for the full detail
behind every `auth` row in the tables below (token lifetimes, device model,
2FA, CSRF).

## Contents

1. [Conventions](#1-conventions)
2. [Auth methods used in the tables below](#2-auth-methods-used-in-the-tables-below)
3. [Route reference](#3-route-reference)
   - [`auth`](#auth)
   - [`users`](#users)
   - [`devices`](#devices)
   - [`sessions`](#sessions)
   - [`settings`](#settings)
   - [`notifications`](#notifications)
   - [`activity` / `sniping` / `trades` / `profits` / `filters` / `risk-events`](#activity--sniping--trades--profits--filters--risk-events)
   - [`extension`](#extension)
   - [`health` / `metrics`](#health--metrics)
   - [`ws`](#ws)
   - [`admin-users` / `admin-audit` / `admin-toggles` / `admin-config` / `admin-system` / `admin-activity`](#admin-users--admin-audit--admin-toggles--admin-config--admin-system--admin-activity)
4. [Error codes](#4-error-codes)
5. [OpenAPI](#5-openapi)

---

## 1. Conventions

- **Base path**: every route in this document is under `/api/v1`, except
  `/health/live`, `/health/ready`, `/metrics`, and the WebSocket upgrade
  itself (`/ws` — see [§3 `ws`](#ws)), which are intentionally unprefixed
  (hit by infra/load balancers or a raw socket client, not API callers).
- **Error envelope**: every non-2xx response is
  `{ code, message, details?, requestId }` (`@sl/shared`'s `apiErrorSchema`).
  `code` is always one of `@sl/shared`'s `ERROR_CODES`; `requestId` mirrors
  the `x-request-id` response header. See [§4](#4-error-codes) for the full
  code → HTTP status table.
- **Pagination**: every list endpoint takes `?cursor=&limit=` (default
  `limit` 50, max 200 unless a route says otherwise) and returns
  `{ items, nextCursor }`. `cursor` is an opaque base64url token from a
  previous page's `nextCursor` — never a raw offset, so pages stay stable
  under concurrent writes. `nextCursor` is `null` on the last page.
- **Auth methods** — see [§2](#2-auth-methods-used-in-the-tables-below).
- **CSRF**: every *cookie-session* mutation (`POST`/`PATCH`/`PUT`/`DELETE`
  called by the dashboard) requires the `x-csrf-token` header matching the
  `sl_csrf` cookie (double-submit). Bearer-authenticated calls (the
  extension) are exempt by construction — see
  [`04-auth.md`](./04-auth.md#csrf-model). Routes below that mutate state
  under a user session are marked "CSRF (cookie only)" in their Notes
  column; GETs never require it.
- **Rate limiting**: a global default (`RATE_LIMIT_GLOBAL_MAX` per
  `RATE_LIMIT_GLOBAL_WINDOW_MS`, default 300/60s, per IP) applies to every
  route. `auth/register`, `auth/login`, `auth/mfa/verify`,
  `auth/resend-verification`, and `auth/password/reset-request` additionally
  carry a stricter per-route override
  (`RATE_LIMIT_LOGIN_MAX`/`RATE_LIMIT_LOGIN_WINDOW_MS`, default 20/15min,
  per IP) — deliberately looser than the 5-failure **account lockout**
  (`users.failed_login_count`/`locked_until`), which is the primary
  brute-force defence per account (see `04-auth.md`); this per-route limit
  is a coarser guard against one IP hammering the route regardless of which
  account. `login`/`register` additionally apply a **Redis sliding-window**
  check per-IP and per-account (also 20/15min by default, same reasoning).
  A 429 body is `{ code: 'RATE_LIMITED', message, details: {
  retryAfterSeconds }, requestId }`.
- **Idempotency**: batch-ingest endpoints (`activity/batch`) dedupe by a
  content hash of each event (§ below) so a retried batch after a dropped
  response is a safe no-op.
- **Request id**: every request gets `x-request-id` (reused from the
  incoming header if the caller already set one) — always present on both
  the response header and the error envelope's `requestId`.
- **Logging**: pino, with `req.headers.authorization`, `req.headers.cookie`,
  passwords/tokens/codes, and `*.email` redacted from structured logs by
  default (`app.ts`'s logger config).

## 2. Auth methods used in the tables below

| Value | Means |
|---|---|
| `public` | No credential required. |
| `user` | `fastify.authenticate` — a valid access token, either `Authorization: Bearer <token>` (the extension) or the `sl_at` httpOnly cookie (the dashboard). Both go through the exact same verification path (docs/04-auth.md). |
| `admin` | `user`, plus the account's `role = 'admin'`. |
| `admin + <permission>` | `fastify.requirePermission('<permission>')` — `admin`, plus the admin's `admin_role` (from `admin_users`) must grant that permission per `@sl/shared`'s `PERMISSION_MATRIX` (docs/04-auth.md §"Admin roles"). |
| `ticket` | A short-lived, single-use, Redis-backed ticket (not a JWT) — `mfaTicket` (2FA step-up) or a WS ticket. |

## 3. Route reference

### `auth`

Full flow diagrams, token lifetimes, lockout/backoff math, and the 2FA
bootstrap flow for admins are in
[`04-auth.md`](./04-auth.md). Module: `src/modules/auth`.

| Method & path | Auth | Rate limit | Notes |
|---|---|---|---|
| `POST /auth/register` | public | login-tier | Body: `registerRequestSchema` (email, password ≥12 chars w/ letter+digit, `device`). Creates the user, sends a 24h email-verification link. `201 { userId }`. |
| `POST /auth/verify-email` | public | global | Body `{ token }`. Marks `email_verified_at`. |
| `POST /auth/resend-verification` | public | login-tier | Body `{ email }`. Always `200 { sent: true }` — never reveals whether the account exists or is already verified. |
| `POST /auth/login` | public | login-tier + Redis sliding window (IP + account) | Body: `loginRequestSchema`. Returns `loginResponseSchema`: either `{ status: 'ok', accessToken, refreshToken, expiresIn }` or `{ status: 'mfa_required', mfaTicket, expiresIn: 300 }` if the account has TOTP enabled, or if it's an admin account without TOTP yet (bootstrap-enrollment ticket — `04-auth.md`). Sets `sl_at`/`sl_rt` cookies either way (extension ignores them and uses the body). Checks account lockout, then `modules/bans`'s `checkBans()` (account/IP/device — cross-agent seam), then issues tokens via `findOrRegisterDevice` (device-limit enforcement, `DEVICE_LIMIT_REACHED` 409 with the device list). |
| `POST /auth/mfa/verify` | `ticket` | login-tier | Body `{ mfaTicket, code }` (6-digit TOTP or an 8+ char recovery code). Completes the pending login from `/login`. `200` with the same `{status:'ok', ...}` shape. |
| `POST /auth/refresh` | `user` (refresh token, not access token — body `{ refreshToken }` or the `sl_rt` cookie) | none | Rotates the refresh token (old row revoked, new row inserted, same family). Reused/superseded token → `AUTH_TOKEN_REUSED` (401) and the whole session family is revoked. |
| `POST /auth/logout` | public (body carries the refresh token) | none | Body `{ refreshToken?, allDevices? }`. `allDevices: true` requires a valid access token too and revokes every session. |
| `POST /auth/logout-all` | `user` | none | Revokes every session for the caller and bumps `users.row_version` (invalidates every outstanding access token immediately, not just refresh tokens). |
| `POST /auth/password/reset-request` | public | login-tier | Body `{ email }`. Always `200 { sent: true }`. |
| `POST /auth/password/reset-confirm` | public | none | Body `{ token, password }`. 1h TTL, single use. Revokes every session and bumps `row_version`. |
| `POST /auth/password/change` | `user` | none | CSRF (cookie only). Body `{ currentPassword, newPassword }`. Revokes every *other* session (all sessions, including the caller's — the caller must re-login/refresh) and bumps `row_version`. |
| `POST /auth/totp/enroll` | `user` **or** `ticket` (body `{ mfaTicket? }`) | none | Starts enrollment: returns `{ secret, otpauthUrl, recoveryCodes: [10] }` (pending, not yet persisted — 10 min TTL in Redis). The ticket path is how an admin without TOTP yet enrolls before their first login can complete (`04-auth.md`). |
| `POST /auth/totp/enroll/confirm` | `user` **or** `ticket` (body `{ mfaTicket?, code }`) | none | Verifies the pending secret's TOTP code, persists it (encrypted) + the 10 recovery codes (argon2-hashed), bumps `row_version`. `200 { enabled: true, tokens? }` — `tokens` is present only on the ticket path (it completes the blocked login in the same call). |
| `POST /auth/totp/disable` | `user` | none | CSRF (cookie only). Body `{ currentPassword, code }` (TOTP or recovery code). Clears the secret + all recovery codes, bumps `row_version`. |
| `POST /auth/device/register` | `user` | none | Body: `deviceFingerprintSchema`. Re-registers/refreshes the caller's device metadata from an already-authenticated session (device-limit enforced the same as login). |

### `users`

Module: `src/modules/users`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /users/me` | `user` | `userDtoSchema`. |
| `PATCH /users/me` | `user` | CSRF (cookie only). Body `updateProfileRequestSchema` (`timezone`). Audited (`user.profile_updated`). |
| `DELETE /users/me` | `user` | CSRF (cookie only). Body `{ password }` (re-auth required). Soft-deletes (`status='deleted'`, `deleted_at`), revokes every session, bumps `row_version`. Audited (`user.deleted`). |

### `devices`

Module: `src/modules/devices`. See [`04-auth.md`](./04-auth.md#device-model)
for the device-limit model.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /devices` | `user` | Every non-deleted device for the caller; `isCurrent` flags the device the calling access token was issued for. |
| `PATCH /devices/:id` | `user` | CSRF (cookie only). Body `{ name }`. |
| `DELETE /devices/:id` | `user` | CSRF (cookie only). Revokes the device *and* every session bound to it. Audited (`device.revoked`). |

### `sessions`

Module: `src/modules/sessions`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /sessions` | `user` | Every active (non-revoked) session; `isCurrent` flags the session the calling access token's `sid` claim points to. |
| `DELETE /sessions/:id` | `user` | CSRF (cookie only). Revokes one session (its refresh token immediately stops working; its access tokens expire naturally within 15 min unless `logout-all`/a password change also bumped `row_version`). |

### `settings`

Module: `src/modules/settings`. Body/response shape is `@sl/shared`'s
`userSettingsSchema` (`targets`, `budgets`, `governor`, `telemetryOptOut`,
`notifications`).

| Method & path | Auth | Notes |
|---|---|---|
| `GET /settings` | `user` | Creates a default document on first read if none exists yet. |
| `PUT /settings` | `user` | CSRF (cookie only). Body `updateUserSettingsRequestSchema` (every section optional, merged server-side). Validates the merged result against `userSettingsSchema`'s absolute limits, **then** against the admin-tunable ceilings in `system_config` (`governor.max_actions_per_hour` etc. — a user may tighten their own governor budget, never loosen it past the plan-wide ceiling). Bumps `version`, writes a `settings_history` row. |
| `GET /settings/history` | `user` | Last 50 versions, newest first. |

### `notifications`

Module: `src/modules/notifications`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /notifications` | `user` | Cursor-paginated, newest first. |
| `POST /notifications/:id/read` | `user` | Marks one notification read. |
| `POST /notifications/read-all` | `user` | Marks every unread notification read. |

Notification *preferences* live under `settings.notifications` (§ above),
not a separate endpoint — `PUT /settings` with a `notifications` patch is
how a client changes them.

### `activity` / `sniping` / `trades` / `profits` / `filters` / `risk-events`

Modules: `src/modules/{activity,sniping,trades,profits,filters,risk-events}`.
These are the extension's own telemetry/data-sync surface — see project
instruction 6 (`docs/01-architecture.md`): account-agnostic product data
only, never raw market observations.

| Method & path | Auth | Notes |
|---|---|---|
| `POST /activity/batch` | `user` | Body `activityIngestBatchSchema` (`@sl/shared`) — up to 500 events (`login`/`logout`/`search`/`filter_change`/`settings_change`/`error`/`heartbeat`). **Idempotent**: each event is deduped by a SHA-256 hash of `(userId, event JSON)` in Redis (24h TTL) — a byte-identical retried event is a no-op. `200 { accepted, deduped }`. `search` events land in `search_activity`; everything else in `user_activity`. |
| `POST /sniping/attempts` | `user` | Body `reportSnipingAttemptsRequestSchema` — up to 200 attempts. `200 { accepted }`. Inserts into `sniping_activity`. |
| `POST /trades/batch` | `user` | Body `reportTradesRequestSchema` — up to 200 trades. Upserts by `(userId, tradeId)` among live rows. `ea_tax` is stored as an integer coin amount (`round(sellPrice * eaTax)`) — the request schema's `eaTax` is a 0–1 fraction, the DB column is integer coins (repo convention: money/coins are always integer). `200 { upserted }`. |
| `GET /trades` | `user` | Cursor-paginated, newest-bought-first. |
| `GET /profits?from=&to=&granularity=` | `user` | `granularity`: `daily` \| `weekly` \| `monthly` \| `lifetime`. Reads the `profits` daily-rollup table (populated hourly by the `profits.rollup` job — §9 of the jobs section in `04-auth.md`'s companion, or see [§ Jobs](#jobs) below) and aggregates in application code for the coarser granularities. `200 { granularity, items: DailyProfit[] }`. |
| `GET /filters` | `user` | Every non-deleted saved filter. |
| `POST /filters` | `user` | Body `createSavedFilterRequestSchema`. `201`. |
| `PATCH /filters/:id` | `user` | Body `updateSavedFilterRequestSchema` (partial). |
| `DELETE /filters/:id` | `user` | Soft delete. |
| `POST /filters/stats` | `user` | Body `reportFilterStatsRequestSchema` — batch upsert of the ranker's realised-return history (`filter_stats`, keyed `(filterId, windowStart)`), synced from the extension so it survives a reinstall. Silently skips stats for a `filterId` that isn't the caller's. |
| `POST /risk-events` | `user` | Body `reportRiskBudgetEventsRequestSchema` — up to 200 governor decisions. `200 { accepted }`. |

### `extension`

Module: `src/modules/extension`. `bootstrapResponseSchema`/
`heartbeatResponseSchema` (`@sl/shared`) are the canonical response shapes —
see [`04-auth.md`](./04-auth.md#license-bootstrap--heartbeat--offline-grace)
for the offline-grace model the `entitlementBlob` supports.

| Method & path | Auth | Notes |
|---|---|---|
| `POST /extension/bootstrap` | `user` | Body `bootstrapRequestSchema` (`device`, `extensionVersion`, `buildTarget`). Called once on startup/after login. Registers/refreshes the device, then returns `{ userId, deviceId, subscription, license, features, settings, killSwitchActive, entitlementBlob, serverTime }`. `subscription`/`license` are read directly from the subscriptions/licenses/plans tables (owned by the subscriptions agent — this is a read-only composition, not a write path). `entitlementBlob` is signed via `fastify.entitlements.signEntitlementBlob()` (Ed25519, `ENTITLEMENT_SIGNING_KEY`) for the extension's 24h offline-grace cache. |
| `POST /extension/heartbeat` | `user` | Body `heartbeatRequestSchema` (`deviceId`, `extensionVersion`, `engineState`). Every ~10 min via an MV3 `alarms` tick (never `setInterval` in the SW). Same response shape as bootstrap minus `userId`. Updates `devices.last_seen_at`/`extension_version`, logs a `heartbeat` activity row. |
| `POST /extension/telemetry` | `user` | Body `telemetryFlushRequestSchema` — up to 500 events. Version/health telemetry only (never enforcement — `activity`/`sniping`/`trades` ingest is). Stored as `user_activity` rows, `type='other'`. |
| `POST /extension/errors` | `user` | Body `extensionErrorReportSchema` — up to 100 errors (the ring-buffer flush). Stored as `user_activity` rows, `type='error'`. |
| `GET /extension/version` | public | `{ latestVersion, updateUrl }` from `EXTENSION_LATEST_VERSION`/`EXTENSION_UPDATE_URL`. |
| `GET /extension/kill-switch` | public | `{ active }` from the `kill_switch` feature toggle — polled as a fallback alongside the WS `kill_switch` push and the bootstrap/heartbeat response's `killSwitchActive` field. |

### `health` / `metrics`

Modules: `src/modules/health` (unprefixed — `/health/*`, not `/api/v1/...`),
`plugins/metrics.ts` (`/metrics`, also unprefixed).

| Method & path | Auth | Notes |
|---|---|---|
| `GET /health/live` | public | `{ status: 'ok' }` — process is up. |
| `GET /health/ready` | public | Checks DB (`SELECT 1`), Redis (`PING`), and a BullMQ queue handle. `200 { status:'ok', checks }` or `503 { status:'error', checks }`. |
| `GET /metrics` | public (network/infra access control in production — never put a secret behind an unauthenticated route in prod without a reverse-proxy ACL) | Prometheus text format: default Node/process metrics + `http_requests_total`/`http_request_duration_seconds` (labelled `method`, `route`, `status`). |

### `ws`

Module: `src/modules/ws`. See
[`01-architecture.md` §3](./01-architecture.md#3-sequence-diagrams) for the
push sequence diagram.

| Method & path | Auth | Notes |
|---|---|---|
| `POST /ws/ticket` | `user` | Issues a 30s-TTL, single-use, Redis-backed ticket (`{ ticket, expiresIn }`) — no signature to verify on the hot upgrade path. |
| `GET /ws?ticket=<ticket>` | `ticket` (query param, consumed via Redis `GETDEL` on upgrade) | **Unprefixed** (`wss://.../ws`, not `/api/v1/ws`). WebSocket upgrade. Subscribes the connection to Redis channel `ws:user:{id}` (always) and `ws:admin:overview` (admin role only). Server → client events are `@sl/shared`'s `wsEventSchema` union (`subscription.changed`, `session.revoked`, `notification.new`, `feature_toggles.changed`, `kill_switch`, `admin.overview.tick`), JSON-encoded. Presence (online users) tracked in Redis, refreshed every 20s while the socket is open; `presence.sweep` (nightly-ish, every 5 min) cleans up connections that died without a close frame. Invalid/expired/missing ticket → the socket is closed immediately with code `4401`; a malformed request (no `ticket` query param at all) closes with `4400`. |

Any module can push a server → client event via
`src/ws/publish.ts`'s `publishToUser(redis, userId, event)` /
`publishAdmin(redis, event)` — both take a validated `WsEvent`, PUBLISH to
the matching Redis channel, and work correctly across multiple API
instances (Redis pub/sub fan-out, not an in-process event emitter).

### `admin-users` / `admin-audit` / `admin-toggles` / `admin-config` / `admin-system` / `admin-activity`

Modules: `src/modules/admin-{users,audit,toggles,config,system,activity}`.
Every route below requires `admin + <permission>`
(`fastify.requirePermission`) — see
[`04-auth.md`](./04-auth.md#admin-roles--permissions) for the full
role → permission matrix and why `support` gets 403 on e.g. `users.ban`
(owned by the subscriptions/moderation `bans` module —
[`05-subscriptions.md`](./05-subscriptions.md)). Every mutating route here
writes both an `audit_logs` row (before/after, via `recordAudit`) and an
`admin_actions` row.

| Method & path | Permission | Notes |
|---|---|---|
| `GET /admin/users?q=&status=&cursor=&limit=` | `users.read` | `q` matches email (case-insensitive substring). Cursor-paginated. |
| `GET /admin/users/:id` | `users.read` | |
| `PATCH /admin/users/:id` | `users.write` | Body `updateProfileRequestSchema`. Audited `user.updated`. |
| `POST /admin/users/:id/suspend` | `users.suspend` | Body `adminSuspendUserRequestSchema` (`reason`, optional `expiresAt`). Revokes every session + bumps `row_version`. Audited `user.suspended`. |
| `POST /admin/users/:id/unsuspend` | `users.suspend` | Body `{ reason }`. Audited `user.unsuspended`. |
| `POST /admin/users/:id/reset-password` | `users.reset_password` | Body `{ reason }`. Triggers the same password-reset email flow as the user-initiated one. Audited `user.reset_password_sent`. |
| `POST /admin/users/:id/force-logout` | `users.force_logout` | Body `{ reason }`. Revokes every session, bumps `row_version`, pushes `session.revoked` over WS for each revoked session, and emails the user a force-logout notice. Audited `user.force_logout`. |
| `GET /admin/audit?actorId=&entityType=&entityId=&from=&to=&limit=` | `audit.read` | `auditLogEntrySchema[]`, newest first. |
| `GET /admin/audit/export.csv?...` (same filters) | `audit.read` | Streams a CSV (`id,occurred_at,actor_type,actor_id,action,entity_type,entity_id,diff`), capped at 10,000 rows. |
| `GET /admin/toggles` | `system.read` | `featureToggleDtoSchema[]`. |
| `PATCH /admin/toggles/:key` | `feature_toggles.write` | Body `updateFeatureToggleRequestSchema`. Broadcasts `feature_toggles.changed` to `admin:overview`; toggling the `kill_switch` key additionally broadcasts `kill_switch`. Audited `feature_toggle.updated`. |
| `GET /admin/config` | `system.read` | `systemConfigDtoSchema[]` — `is_secret` values are masked (`"[hidden]"`) unless the caller also has `config.write`. |
| `PUT /admin/config/:key` | `config.write` | Body `{ value, isSecret?, description? }`. Upserts. Audited `system_config.updated`/`.created` (secret values never appear in the audit row — masked the same way). |
| `GET /admin/system/health` | `system.read` | Process uptime, DB connectivity, parsed `redis INFO` (connected clients/used memory/uptime), per-queue BullMQ depths (every job in `src/jobs/*.job.ts`, both agents' — via a plain, unprefixed Redis connection matching what `worker.ts` itself connects with), WS online-user count (Redis presence set), active-device extension-version distribution, and a 5-minute error rate (Redis minute-bucketed 5xx counter). |
| `GET /admin/activity/{logins,errors,searches,snipes}?from=&to=&cursor=&limit=` | `analytics.read` | Cursor-paginated raw rows from `user_activity` (filtered by `type`), `search_activity`, `sniping_activity`. |
| `GET /admin/activity/devices` | `analytics.read` | `{ byVersion, byOs, total }` — active-device breakdown. |
| `GET /admin/activity/ips?flaggedOnly=&limit=` | `analytics.read` | `ip_activity` rows, newest-seen first. |

---

## 4. Error codes

Every code below is `@sl/shared`'s `ERROR_CODES`; the HTTP status is fixed
per code (`ERROR_STATUS`) — no route chooses its own status for a given
code.

| Code | Status | Typical source |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Bad email/password on login. |
| `AUTH_EMAIL_NOT_VERIFIED` | 403 | Login before verifying email. |
| `AUTH_MFA_REQUIRED` | 401 | An `mfaTicket` was presented for a login that doesn't actually require it (mode mismatch), or a stale enroll ticket used at `/mfa/verify`. |
| `AUTH_MFA_INVALID` | 401 | Wrong TOTP/recovery code. |
| `AUTH_ACCOUNT_LOCKED` | 423 | 5+ consecutive failed logins (`details.retryAfterSeconds`). |
| `AUTH_TOKEN_EXPIRED` | 401 | Expired access or refresh token. |
| `AUTH_TOKEN_INVALID` | 401 | Malformed/unverifiable token, or missing credentials entirely. |
| `AUTH_TOKEN_REUSED` | 401 | A refresh token that was already rotated away was presented again — the whole session family is revoked as a side effect. |
| `AUTH_SESSION_REVOKED` | 401 | The access token's `ver` claim no longer matches `users.row_version` (force-logout/password-change/2FA-change happened since it was issued), or the session backing a refresh token was revoked/its user deactivated. |
| `DEVICE_LIMIT_REACHED` | 409 | Login/bootstrap/device-register with a new device while already at the plan's device limit (`details.devices` — the current list, so the client can offer "revoke one"). |
| `DEVICE_NOT_FOUND` | 404 | `PATCH`/`DELETE /devices/:id` for a device that isn't the caller's. |
| `RATE_LIMITED` | 429 | Any rate limit (global, per-route, or the auth module's Redis sliding windows). |
| `VALIDATION_FAILED` | 400 | Zod schema validation failure (body/query/params). |
| `NOT_FOUND` | 404 | Generic "that row doesn't exist" / unmatched route. |
| `FORBIDDEN` | 403 | Missing admin permission, non-active account, or a ban match (`checkBans`). |
| `CONFLICT` | 409 | E.g. a duplicate registration email, or a second trial while one is already live (owned by the subscriptions module). |
| `INTERNAL` | 500 | Unhandled error — logged server-side, never leaks internals in the response. |
| `KILL_SWITCH_ACTIVE` | 503 | Reserved for a route that itself refuses to operate while the kill switch is active (none of this agent's routes currently do — the extension enforces the kill switch client-side from bootstrap/heartbeat/WS). |
| `MAINTENANCE_MODE` | 503 | Reserved, not currently emitted by any route. |

Codes owned by the subscriptions/licensing domain (`LICENSE_INVALID`,
`LICENSE_EXPIRED`, `LICENSE_REVOKED`, `SUBSCRIPTION_REQUIRED`,
`FEATURE_NOT_ENTITLED`, `TRIAL_ABUSE_DETECTED`) are documented in
[`05-subscriptions.md`](./05-subscriptions.md).

## 5. OpenAPI

Generated from the live route/schema definitions (`@fastify/swagger` +
`fastify-type-provider-zod`) via `pnpm --filter @sl/api openapi`, written to
and committed at
[`apps/api/openapi/openapi.json`](../apps/api/openapi/openapi.json). Every
route's `schema.body`/`schema.querystring`/`schema.response` above is a zod
schema, so the generated document's request/response shapes are always in
sync with what the server actually validates/serializes — this markdown
table is the human-readable index, the JSON file is the source of truth for
tooling (e.g. the dashboard's `openapi-typescript` client).
