// Rate-limit tiers per route class (docs/09-security.md "Rate limiting").
// `plugins/rate-limit.ts` sets the global default (IP+user keyed, see its
// own comment); `modules/auth` already carries its own tight tier
// (`RATE_LIMIT_LOGIN_MAX`/`_WINDOW_MS`, config/env.ts). This file is the
// shared home for the other two tiers so every module that needs one
// imports the same constants instead of each inventing its own numbers:
//
//  - `INGEST_RATE_LIMIT` — the extension's own batched telemetry/data-sync
//    endpoints (`activity`, `sniping`, `trades`, `filters`, `risk-events`,
//    `extension/telemetry`, `extension/errors`). Looser than auth (a
//    logged-in device legitimately calls these often — every heartbeat,
//    every batch flush), tight enough to bound a compromised/bugged
//    extension build hammering the API.
//  - `ADMIN_RATE_LIMIT` — admin mutation routes. Admin traffic is
//    inherently low-volume (a human clicking through a dashboard), so this
//    is mostly a brake on a compromised admin session or a buggy dashboard
//    retry loop, not a routine limit anyone should ever hit legitimately.
//
// Both are plain `@fastify/rate-limit` per-route `config.rateLimit` objects
// — passed as a route's `config: { rateLimit: INGEST_RATE_LIMIT }` — so
// they compose with (are checked in addition to, not instead of) the global
// default tier every route already gets.

export const INGEST_RATE_LIMIT = { max: 120, timeWindow: 60_000 };

export const ADMIN_RATE_LIMIT = { max: 60, timeWindow: 60_000 };

/** Health/liveness/readiness probes are exempt from rate limiting entirely
 * — infra (load balancers, orchestrators) polls them frequently by design,
 * and refusing that traffic would turn a monitoring probe into a
 * self-inflicted outage signal. Applied as a route's `config` verbatim:
 * `{ ..., config: HEALTH_EXEMPT_ROUTE_CONFIG }`. */
export const HEALTH_EXEMPT_ROUTE_CONFIG = { rateLimit: false } as const;
