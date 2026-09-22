# 01 — Architecture

Status: implementation-ready for the phases it covers (architecture +
scaffolding, wave 0). Everything under `apps/api`, `apps/dashboard`,
`packages/db`, `packages/ui`, `infra/` and `tests/` is **designed** here and
**built** in later waves — see [`13-roadmap.md`](./13-roadmap.md) for the
phase-by-phase build order and exit criteria.

This document is the single place that shows how every piece of The
Sniper's Ledger fits together, what data is allowed to cross which boundary,
and why. Every other `docs/*.md` file goes deeper on one slice of this
picture; this one is the map.

## Contents

1. [Component diagram](#1-component-diagram)
2. [Deployment diagram](#2-deployment-diagram)
3. [Sequence diagrams](#3-sequence-diagrams)
4. [Data flow narrative](#4-data-flow-narrative)
5. [Trust boundaries](#5-trust-boundaries--what-crosses-each-one)
6. [Two extension build targets](#6-two-extension-build-targets)
7. [Scaling notes](#7-scaling-notes)
8. [Folder structure cross-reference](#8-folder-structure-cross-reference)

---

## 1. Component diagram

```mermaid
flowchart TB
    subgraph Browser["Player's browser"]
        direction TB
        subgraph MAIN["MAIN world (page context)"]
            Adapter["adapter.ts<br/>THE ONLY EA-aware file<br/>passive observe + probe() + act()"]
        end
        subgraph ISO["ISOLATED world"]
            Content["content/<br/>engine loop lives HERE<br/>(never the service worker)"]
            Ranker["engine/ranker.ts<br/>opportunity scoring"]
            Governor["engine/governor.ts<br/>safety budget, allow()"]
            Assist["engine/assist.ts (M2)"]
            Autobuyer["engine/autobuyer.ts (M3,<br/>ledger-auto build only)"]
            Panel["ui/panel.ts<br/>shadow-DOM readout"]
            IDB[("IndexedDB<br/>store/db.ts<br/>raw observations — LOCAL ONLY")]
        end
        subgraph SW["MV3 service worker (background/)"]
            direction TB
            SWNote["owns NO loops — alarms, storage,<br/>message routing only"]
            AuthLib["lib/auth.ts"]
            LicenseLib["lib/license.ts"]
            TelemetryLib["lib/telemetry.ts"]
            ApiLib["lib/api.ts"]
        end
        Popup["popup/ — status, login, risk meter"]
        Options["options/ — filters, budgets,<br/>governor bounds, telemetry opt-out"]
    end

    EA["EA FC Web App<br/>(ultimate-team/web-app)<br/>+ UTAS transfermarket API"]

    subgraph Backend["apps/api (Fastify)"]
        direction TB
        REST["REST /api/v1/*<br/>auth, users, devices, subscriptions,<br/>licenses, activity, sniping, trades,<br/>profits, filters, admin/*"]
        WS["WS gateway /ws<br/>channels: user:{id}, admin:overview"]
        Jobs["BullMQ workers<br/>profits.rollup, analytics.daily,<br/>subscriptions.expire, abuse.scan, email.send"]
    end

    PG[("PostgreSQL 16<br/>packages/db<br/>NO market_observations table")]
    Redis[("Redis 7<br/>sessions, rate-limit,<br/>queues, pub/sub, presence")]
    Stripe["Stripe<br/>Checkout + Customer Portal + webhooks"]
    Email["Email (Resend/SMTP)"]
    Monitoring["Prometheus + Grafana + Loki<br/>+ OpenTelemetry"]
    Dashboard["apps/dashboard (React)<br/>user + admin UI"]

    Adapter <-- "postMessage, channel 'ledger:v2'<br/>trimmed observations + probe + act results" --> Content
    Adapter -. "reads (passive) / drives via app's<br/>own service layer, never forges a request" .-> EA
    Content --> Ranker --> Governor
    Governor -- allow()/deny --> Assist
    Governor -- allow()/deny --> Autobuyer
    Content --> IDB
    Content --> Panel
    Content <-- "chrome.runtime messages:<br/>record, summary, counts, auth.*,<br/>license.*, settings.*, telemetry.flush,<br/>errors.report, engine.state" --> SW
    Popup --> SW
    Options --> SW
    SW -- "bearer JWT, auto-refresh" --> REST
    SW -- "auth ticket" --> WS
    SW -. "10-min alarm, not a loop" .-> REST

    REST --> PG
    REST --> Redis
    WS --> Redis
    Jobs --> PG
    Jobs --> Redis
    Jobs --> Email
    REST <--> Stripe
    Stripe -- webhooks --> REST
    REST -.-> Monitoring
    WS -.-> Monitoring
    Jobs -.-> Monitoring

    Dashboard -- "httpOnly cookie + CSRF" --> REST
    Dashboard -- "WS, live counters" --> WS
```

**Never-forge-a-request seam.** `adapter.ts` is the only file in the whole
system that knows anything about EA's internals — the same seam that shipped
in milestone 1. It reads market responses passively (patched
`fetch`/`XMLHttpRequest`) and, from M2 onward, drives the web app's own
service layer for `search`/`buy`/`readResult`. It never issues a request EA's
own UI wouldn't have issued, and it verifies its own assumptions on load with
`probe()` (§3.5).

## 2. Deployment diagram

### 2a. MVP: single VM, Docker Compose, Caddy

```mermaid
flowchart TB
    Internet(("Internet"))
    subgraph VM["Single VM (Compose)"]
        Caddy["Caddy<br/>auto-TLS, reverse proxy"]
        subgraph Containers["docker-compose.prod.yml"]
            API1["api (Fastify)<br/>N replicas"]
            WSc["ws gateway<br/>(same image, WS role)"]
            Worker["worker (BullMQ)"]
            Dash["dashboard (static build,<br/>served by Caddy)"]
            PGc[("postgres:16")]
            Redisc[("redis:7")]
            Prom["prometheus"]
            Graf["grafana"]
            Loki["loki"]
            Backup["pg_dump cron container<br/>+ WAL-G notes"]
        end
    end
    ExtUsers["Extension users<br/>(host_permissions: EA + api origin only)"]
    StripeCloud["Stripe"]
    EmailCloud["Resend/SMTP"]

    Internet --> Caddy
    ExtUsers -- HTTPS/WSS --> Caddy
    Caddy --> API1
    Caddy --> WSc
    Caddy --> Dash
    API1 --> PGc
    API1 --> Redisc
    WSc --> Redisc
    Worker --> PGc
    Worker --> Redisc
    Worker --> EmailCloud
    API1 <--> StripeCloud
    API1 --> Prom
    Prom --> Graf
    API1 -.logs.-> Loki
    Backup --> PGc
```

One VM is enough for the MVP's expected load (see §7). `docker-compose.yml`
is the dev stack (Postgres + Redis only, apps run with `pnpm dev`);
`docker-compose.prod.yml` adds Caddy, the built app images, and the
monitoring stack. Both are defined under `infra/docker/` (wave 4).

### 2b. Later shape: Kubernetes

```mermaid
flowchart TB
    Ingress["Ingress (cert-manager, TLS)"]
    subgraph K8s["Kubernetes namespace"]
        APIDeploy["Deployment: api<br/>HPA on CPU + queue depth"]
        WSDeploy["Deployment: ws-gateway<br/>sticky sessions via Redis presence"]
        WorkerDeploy["Deployment: worker<br/>HPA on queue depth"]
        DashDeploy["Deployment: dashboard (static, CDN-fronted)"]
        PGManaged[("Managed Postgres<br/>(RDS/Cloud SQL) + read replica")]
        RedisManaged[("Managed Redis<br/>(cluster mode for pub/sub fanout)")]
        Secrets["External secrets (SOPS/Doppler)"]
    end
    Ingress --> APIDeploy
    Ingress --> WSDeploy
    Ingress --> DashDeploy
    APIDeploy --> PGManaged
    APIDeploy --> RedisManaged
    WSDeploy --> RedisManaged
    WorkerDeploy --> PGManaged
    WorkerDeploy --> RedisManaged
    Secrets -.-> APIDeploy
    Secrets -.-> WorkerDeploy
```

Not built for this MVP (see `13-roadmap.md`'s go-live checklist and "out of
scope" list) — recorded here so the single-VM Compose setup doesn't paint
the API/worker/WS split into a corner. The split already matches: `apps/api`
exposes the REST app, the WS role, and the worker role from one codebase
(three process entry points, §8), so moving from "three Compose services of
one image" to "three K8s Deployments of one image" is a redeploy, not a
rewrite.

## 3. Sequence diagrams

### 3.1 Extension login + device registration

```mermaid
sequenceDiagram
    participant U as User (popup)
    participant SW as Service worker (lib/auth.ts)
    participant API as apps/api (/auth/*, /devices)
    participant Redis as Redis (rate limit, sessions)
    participant PG as Postgres

    U->>SW: submit email + password
    SW->>SW: compute device fingerprint (device/)
    SW->>API: POST /auth/login { email, password, device }
    API->>Redis: check IP + account rate limit / lockout
    alt locked out
        API-->>SW: 423 AUTH_ACCOUNT_LOCKED
    else credentials invalid
        API-->>SW: 401 AUTH_INVALID_CREDENTIALS
    else TOTP enabled
        API-->>SW: 200 { status: mfa_required, mfaTicket }
        SW->>U: prompt for 6-digit code
        U->>SW: code
        SW->>API: POST /auth/mfa/verify { mfaTicket, code }
    end
    API->>PG: verify device_limit for plan; evict oldest or reject
    alt over device_limit and no eviction policy
        API-->>SW: 409 DEVICE_LIMIT_REACHED
    else within limit
        API->>PG: insert/upsert devices row; insert sessions row (family_id)
        API-->>SW: 200 { accessToken (15m, EdDSA), refreshToken (opaque, 30d) }
    end
    SW->>SW: accessToken -> storage.session<br/>refreshToken (encrypted) -> storage.local
    SW-->>U: logged in
    SW->>API: POST /extension/bootstrap (see 3.2)
```

Device fingerprint, browser/OS and extension version are the only
device-identifying fields sent — never anything EA-specific. `sessions.family_id`
is what makes refresh-token rotation reuse-detectable: a reused refresh token
revokes the whole family (`AUTH_TOKEN_REUSED`).

### 3.2 License bootstrap + heartbeat + offline grace

```mermaid
sequenceDiagram
    participant SW as Service worker
    participant API as apps/api (/extension/bootstrap, /extension/heartbeat)
    participant PG as Postgres
    participant Local as storage.local (signed entitlement blob)

    Note over SW: On startup / after login
    SW->>API: POST /extension/bootstrap { device, extensionVersion, buildTarget }
    API->>PG: load subscription, license, feature_toggles, user_settings
    API->>API: sign entitlement blob (server key)
    API-->>SW: { subscription, license, features, settings,<br/>killSwitchActive, entitlementBlob, serverTime }
    SW->>Local: cache entitlementBlob + serverTime

    loop every 10 minutes, via chrome.alarms (never setInterval)
        SW->>API: POST /extension/heartbeat { deviceId, extensionVersion, engineState }
        alt API reachable
            API->>PG: refresh entitlement, check kill switch
            API-->>SW: fresh entitlementBlob + killSwitchActive
            SW->>Local: replace cached blob
        else API unreachable (offline)
            SW->>Local: read cached blob
            SW->>SW: verify signature + check blob.serverTime within 24h grace
            alt within grace
                SW-->>SW: continue operating on cached entitlement
            else grace expired
                SW-->>SW: downgrade to M1 read-only (no assist/automation)
            end
        end
    end
```

The 24h offline grace exists so a transient network blip doesn't strand a
paying user mid-session; it is bounded specifically so a revoked/expired
license can't be used indefinitely offline. `killSwitchActive` is checked on
every successful heartbeat in addition to the WS push (§3.6) so a device that
missed the WS message still catches the kill switch within 10 minutes.

### 3.3a Market observation flow — stays local

```mermaid
sequenceDiagram
    participant EA as EA web app (its own JS)
    participant Adapter as adapter.ts (MAIN world)
    participant Content as content/ (ISOLATED world)
    participant IDB as IndexedDB (store/db.ts)
    participant Panel as ui/panel.ts

    EA->>EA: user runs a market search (app's own UI)
    EA->>Adapter: fetch/XHR response for the market path (adapter reads it passively)
    Adapter->>Adapter: trimAuction() — keep only tradeId, resourceId,<br/>assetId, rating, buyNow, startingBid,<br/>currentBid, offers, expiresAt, seenAt
    Adapter->>Content: postMessage(channel 'ledger:v2', kind 'auctions', trimmed auctions)
    Content->>IDB: recordSightings(auctions) — batched, local origin only
    Content->>Panel: update floor/median/sell-through/max-snipe
    Note over IDB: Nothing here ever leaves the browser.<br/>No server-side observation table exists.
```

### 3.3b Telemetry flow — what leaves the machine, itemised

```mermaid
sequenceDiagram
    participant Content as content/
    participant SW as Service worker
    participant API as apps/api

    Note over Content,API: Everything below is account-agnostic product<br/>data the user can see in Settings > "What it sends",<br/>and can opt most of it out of (telemetryOptOut).
    Content->>SW: activity events (login/logout/search/filter_change/<br/>settings_change/error/heartbeat)
    Note right of Content: search event = filterHash + resultsCount + floorPrice.<br/>Never the listings themselves.
    SW->>API: POST /activity (batched, ≤500/request)
    Content->>SW: sniping attempts (resourceId, tradeId, target/listed<br/>price, outcome, latencyMs, errorCode)
    SW->>API: POST /sniping
    Content->>SW: trades (computed client-side: buy/sell price, net profit)
    SW->>API: POST /trades
    Content->>SW: filter stats (realised coins/hour per saved filter)
    SW->>API: POST /filters/stats
    Content->>SW: risk budget events (governor decisions: kind, value, threshold)
    SW->>API: POST /risk-events
    SW->>API: POST /extension/telemetry (version/health pings, opt-out honoured client-side)
    SW->>API: POST /extension/errors (message, stack, context — no user input echoed)
```

The itemised list above **is** the trust-boundary contract for telemetry —
see §5 for the same list framed as "what crosses the boundary and why," and
`docs/06-extension.md` for the user-facing "What it sends" copy this maps
to 1:1.

### 3.4 Snipe attempt lifecycle

```mermaid
sequenceDiagram
    participant Ranker as engine/ranker.ts
    participant Governor as engine/governor.ts
    participant Assist as engine/assist.ts / autobuyer.ts
    participant Adapter as adapter.ts (act surface)
    participant EA as EA web app
    participant SW as Service worker
    participant API as apps/api
    participant PG as Postgres

    Ranker->>Ranker: score opportunity (EV = (predicted sale - 5% tax - price) * P(sell))
    Ranker->>Assist: ranked candidate
    Assist->>Governor: allow('buy', context)
    alt governor denies (budget/ratio/cooldown/kill switch)
        Governor-->>Assist: deny(reason)
        Assist->>SW: risk_budget_event (kind, value, threshold)
        Assist->>SW: sniping attempt { outcome: 'blocked', errorCode }
    else governor allows
        Governor-->>Assist: allow()
        Assist->>Adapter: act('buy', tradeId, price) — drives the app's own buy control
        Adapter->>EA: (the app's own request, unmodified)
        EA-->>Adapter: result
        Adapter-->>Assist: action_result { ok, latency }
        Assist->>SW: sniping attempt { outcome: success|failed|too_slow|error, latencyMs }
        alt success
            Assist->>SW: trade { status: 'bought', buyPrice, resourceId }
        end
    end
    SW->>API: POST /sniping, /risk-events, /trades (batched)
    API->>PG: insert sniping_activity, risk_budget_events, trades
    Note over API,PG: profits.rollup job (hourly) aggregates trades +<br/>sniping_activity into the profits daily rollup
```

Every branch — including the blocked one — is reported, which is what lets
the dashboard's risk posture view (docs/08-analytics.md) show the governor
actually doing its job rather than just trusting that it did.

### 3.5 Adapter bundle probe (shape hard-stop)

```mermaid
sequenceDiagram
    participant Adapter as adapter.ts
    participant Content as content/
    participant Panel as ui/panel.ts

    Adapter->>Adapter: probe() at load — verify the web app's<br/>service layer still has the expected shape
    alt shape matches
        Adapter->>Content: postMessage kind 'probe' { ok: true }
        Content->>Panel: health = live
    else shape changed (EA shipped a bundle update)
        Adapter->>Content: postMessage kind 'probe' { ok: false, reason }
        Content->>Content: hard-stop the engine (ranker/governor/assist never run)
        Content->>Panel: health = warn, amber banner with reason
    end
```

This is the same "break loudly" contract milestone 1 already has for the
passive observation path (`kind: 'shape'`), extended to cover the `act`
surface before M2/M3 are allowed to use it at all.

### 3.6 Admin action → audit log

```mermaid
sequenceDiagram
    participant Admin as Admin (dashboard)
    participant API as apps/api (admin/* route, requirePermission)
    participant PG as Postgres

    Admin->>API: PATCH /admin/users/{id}/suspend { reason }
    API->>API: requirePermission(session.adminRole, 'users.suspend')
    alt not permitted
        API-->>Admin: 403 FORBIDDEN
    else permitted
        API->>PG: SELECT current row (before)
        API->>PG: UPDATE users SET status='suspended', row_version+1 (after)
        API->>API: diff(before, after)
        API->>PG: INSERT admin_actions (admin_user_id, action, target, reason)
        API->>PG: INSERT audit_logs (actor_type='admin', before, after, diff,<br/>request_id, ip, user_agent) — append-only, REVOKE UPDATE/DELETE
        API-->>Admin: 200 { user }
        API->>API: enqueue WS push: session.revoked for the affected user's sessions
    end
```

Every admin mutation schema (`adminActionRequestSchema` in `@sl/shared`)
requires a `reason`, so there is no code path that writes an `admin_actions`
row without one.

### 3.7 WS push: force logout, subscription change, kill switch

```mermaid
sequenceDiagram
    participant API as apps/api
    participant Redis as Redis pub/sub
    participant WS as WS gateway
    participant SW as Service worker (extension)
    participant Dash as Dashboard

    API->>Redis: PUBLISH user:{id} { type: 'session.revoked', sessionId, reason }
    Redis-->>WS: fan-out to every gateway instance
    WS->>SW: push (if connected) — else the 10-min heartbeat catches it
    SW->>SW: drop cached tokens, force re-login

    API->>Redis: PUBLISH user:{id} { type: 'subscription.changed', subscription }
    Redis-->>WS: fan-out
    WS->>SW: push
    WS->>Dash: push
    SW->>SW: refresh cached entitlements without waiting for next heartbeat

    API->>Redis: PUBLISH * { type: 'kill_switch', active: true, reason }
    Note over API,Redis: Broadcast — every connected user:{id} channel,<br/>plus admin:overview.
    Redis-->>WS: fan-out to all
    WS->>SW: push
    SW->>SW: engine.state -> halted immediately, regardless of build target
```

## 4. Data flow narrative

- **Recording (M1, always local).** The adapter watches the app's own
  network traffic, trims each auction to the model's inputs, and the content
  script writes it to the extension's own IndexedDB. No account is required
  for this to work at all — it is the same as today.
- **Product telemetry (M2+, account required).** Once logged in, the
  extension reports _about_ the user's activity — never the market data
  itself — in small, typed, batched POSTs (§3.3b). Every one of those event
  types is enumerated in `packages/shared/src/schemas/activity.ts` and
  friends; nothing ad-hoc gets appended without a schema change.
- **Entitlement (M2+).** Bootstrap/heartbeat is a pull (extension asks "am I
  still allowed"), the WS push is the complementary interrupt (server says
  "something changed, don't wait for the next heartbeat"). Both funnel into
  the same cached, signed entitlement blob so the engine has one source of
  truth for "can I run right now."
- **Action (M2 assist / M3 automation).** The ranker only ever proposes; the
  governor only ever allows or denies; the adapter only ever drives the
  app's own control. No component in this chain can skip the one before it
  — `assist.ts`/`autobuyer.ts` call `governor.allow()` before every single
  `adapter.act()`, not once per session.
- **Rollup.** Trades and sniping attempts land as raw rows; `profits.rollup`
  (hourly) and `analytics.daily` (nightly) are the only things that
  aggregate them, so the raw rows stay the audit trail and the rollups stay
  cheap to query.

## 5. Trust boundaries — what crosses each one

| Boundary                                      | Crosses                                                                                                                                                                                                                                                                            | Never crosses                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **EA web app ↔ adapter.ts (MAIN world)**      | Nothing sent _to_ EA beyond what its own UI would already send. Read: market response bodies (passive).                                                                                                                                                                            | A forged/replayed request; a lifted session header used outside the app's own calls.                                         |
| **adapter.ts ↔ content script (postMessage)** | Trimmed auctions (`trimAuction` fields only — §3.3a), probe/shape status, action results.                                                                                                                                                                                          | The EA session token, club data, trade history, anything not explicitly copied by `trimAuction`.                             |
| **content/background ↔ IndexedDB**            | Raw + trimmed observations, local settings cache.                                                                                                                                                                                                                                  | Nothing leaves this boundary at all — it's the terminus, not a hop.                                                          |
| **Extension ↔ apps/api**                      | Auth (email + password/MFA code, never stored plaintext beyond the request), device fingerprint (opaque hash + browser/OS/ext version), activity metadata (§3.3b list, exhaustive), sniping attempts, trades, filter stats, risk events, telemetry/error pings, settings document. | Raw market listings, EA session/auth data, club contents, trade history from the game itself.                                |
| **apps/api ↔ Postgres**                       | Everything the API persists, always parameterised (Drizzle query builder or `sql.raw()` with constants — never `sql` template interpolation, enforced by the repo ESLint rule).                                                                                                    | Plaintext passwords (argon2id only), plaintext refresh tokens (hashed), plaintext TOTP secrets (pgcrypto column encryption). |
| **apps/api ↔ Stripe**                         | Checkout/portal session creation, webhook receipt (signature-verified).                                                                                                                                                                                                            | Full card data (Stripe-hosted Checkout/Portal only — PCI scope stays with Stripe).                                           |
| **apps/api ↔ Dashboard**                      | Everything a role's permission matrix allows (`@sl/shared` `hasPermission`), via httpOnly cookie + CSRF, never a bearer token in JS-readable storage.                                                                                                                              | Any admin surface without a `requirePermission` check; any user's data outside their own session's `user_id` scope.          |
| **host_permissions (extension manifest)**     | EA web-app origins + our own API origin. Nothing else.                                                                                                                                                                                                                             | Any third-party domain — there is no host permission that would let the extension talk to one.                               |

The one-line version: **raw market data has a trust boundary of exactly
one — the browser — and it never gets a second one.** Everything else that
does cross into the backend is listed exhaustively above and in
`docs/06-extension.md`'s "What it sends" page, which is the user-facing
mirror of this table.

## 6. Two extension build targets

|              | `ledger`                                                                                                | `ledger-auto`                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Contains     | M1 recorder + M2 assist                                                                                 | M1 + M2 + M3 automation (`engine/autobuyer.ts`)                                                                                |
| Distribution | Chrome Web Store (listable)                                                                             | Self-hosted (`update_url` points at our own update manifest, per CWS policy for tools that automate gameplay)                  |
| Build flag   | `VITE_AUTOMATION=0` (default)                                                                           | `VITE_AUTOMATION=1`                                                                                                            |
| Tree-shaking | `autobuyer.ts` and its manifest entries are excluded entirely — not just feature-flagged off at runtime | N/A (included)                                                                                                                 |
| Entitlement  | `automation.autobuyer` feature key is never granted meaning for this build                              | Still gated by `automation.autobuyer` (plan) **and** the governor at runtime — a build flag is distribution, not authorization |
| Governor     | Present and active (blocks nothing further to block)                                                    | Present, active, and the only thing standing between the ranker and `adapter.act()`                                            |

Both targets share every other file. The split happens at the Vite/crxjs
build config level (multi-entry, per-target manifest generation) — see
`docs/06-extension.md` for the exact build commands once that wave lands.

## 7. Scaling notes

- **Postgres partitioning.** `user_activity`, `search_activity`,
  `sniping_activity` and `audit_logs` are declaratively range-partitioned by
  month (see `docs/02-database.md` once `packages/db` lands). A BRIN index
  on the partition key (`occurred_at`) keeps insert-heavy, append-only
  tables cheap to write and to prune (old partitions are dropped, not
  deleted row-by-row).
- **Redis pub/sub fan-out.** The WS gateway is stateless per connection
  beyond "which `user:{id}`/`admin:overview` channels this socket
  subscribes to" — actual event delivery goes through Redis pub/sub so any
  gateway instance can receive an event from `apps/api` and push it to
  whichever instance holds that user's socket. This is what makes the WS
  gateway horizontally scalable without sticky-session tricks beyond what
  Redis presence already needs.
- **Workers.** BullMQ queues (`profits.rollup`, `analytics.daily`,
  `subscriptions.expire`, `licenses.revalidate`, `abuse.scan`,
  `email.send`, `audit.retention`) run in a separate process
  (`apps/api/src/worker.ts`) from the REST/WS process, so a slow analytics
  job never adds latency to a login request. Each queue scales
  independently by concurrency setting, not by adding API replicas.
- **Read path.** `analytics_daily` is a materialised KPI store precisely so
  the admin dashboard's overview never runs an aggregate query against
  `sniping_activity` directly — it reads a small, pre-computed table
  instead.
- **When to move to Kubernetes (§2b).** The single-VM Compose setup handles
  the MVP's expected load comfortably; the trigger to move is CPU/memory
  headroom on the VM under real traffic, not a fixed user count — tracked in
  `docs/13-roadmap.md`'s go-live checklist.

## 8. Folder structure cross-reference

```
apps/
  extension/   §1 (Browser subgraph), §6      — this repo, today
  api/         §1 (Backend subgraph), §7      — wave 2
  dashboard/   §1 (Dashboard), §3.6            — wave 3
packages/
  shared/      §3 (every payload shape), §5    — this repo, today
  config/      shared tsconfig/eslint/prettier — this repo, today
  db/          §2, §7 (partitioning)           — wave 1
  ui/          dashboard + popup/options theme — wave 5
infra/         §2a compose/Caddy, §2b K8s notes — wave 4
tests/         fixtures for §3's sequences      — wave 5
docs/          02–13, each expanding one section of this file
```
