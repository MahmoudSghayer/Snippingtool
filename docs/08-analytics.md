# 08 — Analytics

Status: implementation-ready. Covers `apps/api/src/lib/analytics/**`,
`apps/api/src/modules/analytics/**` (user-facing), `apps/api/src/modules/
admin-analytics/**` (admin), `apps/api/src/jobs/analytics.daily.job.ts` /
`analytics.hourly.job.ts`, and `apps/api/src/lib/analytics/backfill.ts`.
Read [`02-database.md`](./02-database.md) first for `profits`, `trades`,
`sniping_activity`, `search_activity`, `user_activity`, `subscriptions`,
`payments`, `extension_installs`, `devices`, `analytics_daily`, and the
`v_*` views / `mv_kpi_daily` this document builds on. Read
[`03-api.md`](./03-api.md) for the request/response envelope, pagination
and rate-limit conventions every route below follows.

## Contents

1. [Design](#1-design)
2. [KPI formulas](#2-kpi-formulas)
3. [Profit analytics](#3-profit-analytics)
4. [Activity analytics](#4-activity-analytics)
5. [Subscription metrics](#5-subscription-metrics)
6. [Feature usage, extension usage, errors, performance](#6-feature-usage-extension-usage-errors-performance)
7. [Granularity, gap-filling and timezone handling](#7-granularity-gap-filling-and-timezone-handling)
8. [Materialisation](#8-materialisation)
9. [Endpoint reference](#9-endpoint-reference)
10. [Reports / exports](#10-reports--exports)
11. [Known limitations](#11-known-limitations)

---

## 1. Design

`src/lib/analytics/*.ts` is a set of pure query functions over Drizzle (plus
one Redis read for online-user presence and one `prom-client` registry read
for latency percentiles). No function in this layer mutates anything except
`materialize.ts`'s `upsertAnalyticsDaily`/`materializeDay`, which write to
`analytics_daily` only. Every query is built with the Drizzle query builder
or parameterised `sql` template — this repo's eslint preset hard-bans a
`sql` tagged template with **any** interpolated expression (`no-restricted-
syntax`, see `packages/config/eslint-preset.js`), so every aggregate here
uses Drizzle's `count()`/`sum()`/`countDistinct()` helpers or a constant-text
`sql` fragment with zero `${}` expressions — never string-built SQL.

Two consumption paths read the same functions:

- **Live queries** (`modules/analytics`, `modules/admin-analytics`) call
  them directly, computing every number on request from the source tables
  (`profits`, `user_activity`, `search_activity`, `sniping_activity`,
  `subscriptions`, `payments`, …). This is always exact and always
  reflects the current data.
- **Materialisation** (`lib/analytics/materialize.ts`, run by the
  `analytics.daily`/`analytics.hourly` jobs) calls a subset of the same
  functions once per day and writes the results into `analytics_daily` as
  `(day, metric, dimension, value)` rows, for cheap historical trend
  queries and as the source for `mv_kpi_daily`'s refresh. Live queries do
  **not** read from `analytics_daily` — every endpoint in this document
  computes its answer live except where §10 says otherwise. `analytics_daily`
  exists for trend-over-time dashboards that want to plot many past days
  cheaply, not as the source of truth for "what is X right now".

---

## 2. KPI formulas

All in `lib/analytics/kpi.ts`. `from`/`to` are inclusive UTC calendar days.

| Metric | Formula | Notes |
|---|---|---|
| `totalUsers` | `COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at <= end_of(to)` | Cumulative signups as of the end of `to`. |
| `activeUsers7d` / `activeUsers30d` | `COUNT(DISTINCT user_id) FROM user_activity WHERE occurred_at IN [end_of(to) - N days, end_of(to))` | N = 7 or 30. Any `user_activity` row counts (login, search, heartbeat, …). |
| `onlineUsers` | `SCARD presence:online` (Redis, `src/ws/presence.ts`) | Real-time only — reflects "now", not `to`. Reused read-only, not re-implemented. |
| `totalRevenueCents` | `SUM(amount_cents) FROM payments WHERE status='succeeded' AND created_at IN [from, end_of(to))` | |
| `mrrCents` / `arrCents` | `v_mrr.mrr_cents` / `v_arr.arr_cents` | Point-in-time snapshot of *now*, not range-dependent — see `02-database.md` for the view's own formula (active, non-lifetime subscriptions, price normalised to monthly: year÷12, week×4.345, day×30.44). |
| `conversion.rate` | see below | |
| `churn.rate` | see below | |
| `retention[]` | see below | |
| `extensionInstalls` | `COUNT(*) FROM extension_installs WHERE uninstalled_at IS NULL`, plus a `byBrowser` breakdown | Not range-dependent — always "installs live right now". |
| `versionDistribution` | same install set, grouped by `version` | |

### Conversion (trial → paid within 30 days)

This schema **never mutates a trial subscription row into a paid one in
place**. Two facts force that:

1. `subscriptions_trial_ends_only_when_trialing` (a DB CHECK constraint,
   `migrations/0006_subscriptions.sql`) requires `trial_ends_at` to be
   `NULL` the instant `status` leaves `'trialing'` — the trial-expiry sweep
   clears it in the same `UPDATE` that sets `status = 'expired'`.
2. `subscriptions_one_live_per_user` (a partial unique index) means the
   checkout/admin-activate code paths refuse to touch a user who still has
   *any* live subscription — so a paid subscription is always a **separate
   row**, created only after the trial row has stopped being live.

So conversion is computed by correlating two rows per user, not one row's
field mutation:

- **Cohort**: subscriptions whose `plan.code = 'trial'` and whose
  `created_at` falls within `[from, to]` (`cohortSize`).
- For each cohort row, its **trial-end reference** is `ended_at` if the
  trial has already run its course (set by the expiry sweep), else
  `trial_ends_at` for one still in progress at query time.
- **Converted**: the same `user_id` has at least one *other* subscription
  row (different `id`, a non-`trial` plan) whose `created_at` falls in
  `[reference, reference + 30 days]`.
- `rate = converted / cohortSize` (`0` when the cohort is empty).

Worked example (see `lib/analytics/__tests__/kpi.test.ts` for the exact
fixture): 4 trials start in February; one user's trial ends and they check
out for `pro` 5 days later (converted); one is still trialing (not yet
decided); one converts 40 days after their trial ended (too late, doesn't
count); one never converts. `cohortSize = 4`, `converted = 1`, `rate = 0.25`.

### Churn

Also deliberately avoids reading a subscription row's *current* `status` —
a single mutable-state column can't answer "was this live at a past
instant" once it's been overwritten. Only lifecycle timestamps are used,
since those are set once and never reverted:

- **`activeAtStart`**: subscriptions created before `from` whose
  cancellation/end (if any) had not yet happened as of the instant `from`
  begins: `created_at <= from AND (canceled_at IS NULL OR canceled_at >
  from) AND (ended_at IS NULL OR ended_at > from)`. `canceled_at` is set
  the instant a user requests cancellation (even though `status` itself
  often doesn't flip to `'canceled'` until the current period actually
  ends), so this correctly counts a "pending cancellation" row as live at
  `from`.
- **`churned`**: subscriptions whose `canceled_at` (preferred — the
  user-initiated event) or, failing that, `ended_at` (a hard expiry with no
  explicit cancellation, e.g. an unconverted trial lapsing) falls within
  `[from, to)`.
- `rate = churned / activeAtStart` (`0` when `activeAtStart` is `0`).

### Retention (D7 / D30 cohort, by signup week)

- **Cohort**: users whose `created_at` falls within `[from, to]`, grouped
  by the Monday (UTC) of their signup week — `cohortWeek`.
- **D7 retained**: cohort member has ≥1 `user_activity` row on the *exact*
  calendar day `signup_day + 7` (a fixed 24h UTC window, not "any activity
  since"). **D30 retained**: same test at `signup_day + 30`.
- `retentionD7 = retainedD7 / cohortSize`, `retentionD30 = retainedD30 /
  cohortSize`, per cohort week.

This is "N-day retention" (active on exactly day N after signup), the
simplest and most common definition — not "N-day rolling retention" (active
at any point on or after day N), which would double-count a user who is
merely still using the product continuously.

---

## 3. Profit analytics

`lib/analytics/profits.ts`, backed entirely by the `profits` daily rollup
table (maintained by the `profits.rollup` hourly job — see
`02-database.md` §6.6) — never by `trades` directly, so these numbers
always match what a user's own `/api/v1/profits` shows for the same range.

| Function | What it computes |
|---|---|
| `getPlatformProfitSeries(db, {from, to, granularity})` | Platform-wide series, bucketed (§7) and zero-filled. Each point: `netProfit`, `coinsSpent`, `coinsEarned`, `coinsTraded` (`coinsSpent + coinsEarned` — "total coins traded"), `snipes`, `successes`, `tradesClosed`, `activeTraders` (distinct `user_id` count in that bucket), `snipeSuccessRate` (`successes / snipes`, `0` if `snipes = 0`). |
| `getUserProfitSeries(db, userId, params)` | Same shape, scoped to one user. Backs `/api/v1/analytics/me/profits`. |
| `getUserLifetimeProfit(db, userId)` | All-time per-user totals, from `v_user_lifetime_profit`. |
| `getPlatformLifetimeSummary(db, {from, to})` | `netProfit` and `coinsTraded` summed over the whole range, plus `avgProfitPerActiveTrader = netProfit / distinct active traders in range`. |
| `getProfitLeaderboard(db, {from, to, limit, order})` | Top-N (`order: 'top'`) or least-N (`order: 'least'`) users by `SUM(net_profit)` over `[from, to]`, computed in Postgres via `GROUP BY` + `sum()`/`ORDER BY`, not by loading every row into the app. Ties broken by `user_id` ascending for a stable, deterministic order. |

---

## 4. Activity analytics

`lib/analytics/activity.ts`. One function, `getActivitySeries(db, {from, to,
granularity, userId?})` (`userId` omitted = platform-wide, admin view; set =
scoped, `/api/v1/analytics/me/activity`), sourced from three tables:

| Field | Source |
|---|---|
| `logins` | `user_activity` rows with `type = 'login'` |
| `filterChanges` | `user_activity` rows with `type = 'filter_change'` |
| `errors` | `user_activity` rows with `type = 'error'` |
| `searches` | one row per `search_activity` row |
| `snipeAttempts` | one row per `sniping_activity` row (every outcome, including `'attempted'`/`'blocked'`/`'error'`, counts as an attempt) |
| `snipeSuccesses` | `sniping_activity` rows with `outcome = 'success'` |
| `activeDevices` | distinct `device_id` across all three source tables in the bucket |
| `activeIps` | distinct `ip` from `user_activity` rows in the bucket (the only one of the three tables that carries an IP) |

---

## 5. Subscription metrics

`lib/analytics/subscriptions.ts`.

| Field | Formula |
|---|---|
| `newSubscriptions` (per bucket) | subscriptions whose `created_at` falls in that bucket |
| `canceledSubscriptions` (per bucket) | subscriptions whose `canceled_at` falls in that bucket |
| `trialStarts` (per bucket) | of the above "new" subscriptions, those with `trial_ends_at` set (i.e. plan = `trial`) |
| `trialConversions` (per bucket) | subscriptions passing the §2 conversion test, bucketed by *when billing started* (`current_period_start`) rather than by trial-cohort week — "conversions that happened in this bucket" |
| `couponRedemptions` (per bucket) | `coupon_redemptions` rows whose `redeemed_at` falls in that bucket |
| `planMix` | current (as of "now") distribution of live subscriptions (`v_active_subscriptions`' status set) by `plans.code` — a snapshot, not range-dependent |
| `pastDueCount` | current count of subscriptions with `status = 'past_due'` — a snapshot |

---

## 6. Feature usage, extension usage, errors, performance

- **Feature usage** (`lib/analytics/features.ts`): `user_activity` rows in
  `[from, to]` whose `metadata->>'feature'` is a non-empty string, grouped
  by that value. This is an opt-in convention — any activity-recording call
  site (extension or dashboard) can tag an event with a `feature` key in
  its metadata JSON to show up here; nothing in this deliverable mandates
  which features do.
- **Extension usage** (`lib/analytics/extension.ts`): `heartbeats` =
  `user_activity` rows with `type = 'heartbeat'` in `[from, to]` (written
  by `POST /api/v1/extension/heartbeat`); `activeInstalls`, `byVersion`,
  `byBrowser` = a snapshot of live (`uninstalled_at IS NULL`)
  `extension_installs` rows.
- **Error rates** (`lib/analytics/errors.ts`): `extensionErrorsInRange` =
  `COUNT(*) FROM user_activity WHERE type = 'error' AND occurred_at IN
  [from, to)` (written by `POST /api/v1/extension/errors`);
  `apiServerErrorsLast5Min` = the existing rolling Redis 5xx counter
  (`src/lib/error-rate.ts`'s `getErrorRate`, already used by
  `admin-system`'s health endpoint — read-only reuse here, real-time only,
  not range-dependent).
- **Performance** (`lib/analytics/performance.ts`): p50/p95/p99 request
  latency, read from the `http_request_duration_seconds` `prom-client`
  histogram `plugins/metrics.ts` already maintains. Every route/method/
  status label series is merged into one cumulative histogram (valid,
  since each series counts a disjoint subset of the same request stream),
  then the standard Prometheus `histogram_quantile` linear-interpolation
  estimate is applied within the bucket that first reaches the target
  rank. **This is a bucket-width-bounded approximation**, not an exact
  percentile — with this repo's bucket boundaries (5ms–5s), the error is at
  most the width of the bucket the true percentile falls in. Real-time
  only (reflects the process's metrics since last restart); has no `from`/
  `to` parameter.

---

## 7. Granularity, gap-filling and timezone handling

`lib/analytics/dates.ts` is the one bucketing implementation every series
function shares.

- **`day`**: one bucket per UTC calendar day.
- **`week`**: Monday (UTC)-anchored ISO week — a day's bucket key is the
  Monday of its week.
- **`month`**: the 1st of that UTC month.
- **`lifetime`**: the entire `[from, to]` range collapses into one bucket
  keyed `"lifetime"`.
- **Gap-filling**: every series is computed over the *complete* bucket axis
  for `[from, to]` at the requested granularity — a day/week/month with no
  underlying rows still appears in the output with every numeric field at
  `0` (and `snipeSuccessRate` at `0`, not `NaN`), never omitted.

**Timezone handling**: every range-query schema accepts a `tz` field for
forward compatibility, but bucket-boundary math in this deliverable is
**UTC-only**. `profits` (the profit-series source of truth) is a `date`
column with no per-row timezone — it is already "the UTC calendar day" by
construction (populated by `profits.rollup`, which buckets by UTC day) — so
correct per-viewer DST-aware bucketing would require re-deriving every
stored day from raw `timestamptz` activity rows in the viewer's zone, which
`profits` does not support without a schema change outside this agent's
ownership. This is a documented limitation (§11), not silently ignored.

---

## 8. Materialisation

`lib/analytics/materialize.ts`:

- `computeDailyMetrics(db, day)` — pure; computes every metric below for
  one UTC day and returns `{ day, metric, dimension, value }[]`.
- `upsertAnalyticsDaily(db, rows)` — `INSERT … ON CONFLICT (day, metric,
  dimension) DO UPDATE SET value = excluded.value`. Idempotent: re-running
  for a day whose underlying data hasn't changed produces byte-identical
  rows; re-running after the data *has* changed overwrites in place
  (upsert), never appends a duplicate.
- `materializeDay(db, day)` — `computeDailyMetrics` + `upsertAnalyticsDaily`
  in one call; returns the row count written.
- `refreshMvKpiDaily(db)` — `SELECT refresh_mv_kpi_daily()`
  (`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_kpi_daily`, per
  `02-database.md`).

Metrics written per day (all dimension `''` unless noted): `new_users`,
`active_users_7d`, `active_users_30d`, `revenue_cents`, `mrr_cents`,
`arr_cents`, `net_profit_cents`, `coins_spent`, `coins_earned`,
`coins_traded`, `snipes`, `snipe_successes`, `trades_closed`, `logins`,
`searches`, `filter_changes`, `snipe_attempts`, `errors`, `active_devices`,
`active_ips`, `new_subscriptions`, `canceled_subscriptions`,
`trial_starts`, `trial_conversions`, `coupon_redemptions`,
`extension_installs_total`, `extension_installs` (dimension = browser),
`plan_mix` (dimension = plan code), `past_due_count`, `feature_usage`
(dimension = feature key). `online_users` is **not** materialised — it has
no historical meaning (§11).

### Jobs

| Job | Schedule | What it does |
|---|---|---|
| `analytics.daily` (`src/jobs/analytics.daily.job.ts`) | `0 2 * * *` (02:00 UTC nightly) | `materializeDay` for **yesterday** (UTC), then `refreshMvKpiDaily`. Runs after `profits.rollup` (hourly) and the 5-minute subscription/license jobs, so yesterday's data is long finalised. |
| `analytics.hourly` (`src/jobs/analytics.hourly.job.ts`) | `20 * * * *` (hourly, offset a few minutes past `profits.rollup`'s `:07`) | `materializeDay` for **today** (UTC) — a partial-day snapshot that converges to the full day's numbers as more of today's data lands, the same self-healing idempotent-upsert pattern as `profits.rollup.job.ts`. Does **not** refresh `mv_kpi_daily` (once/night is enough). |

### Backfill

`pnpm --filter @sl/api analytics:backfill --from YYYY-MM-DD [--to
YYYY-MM-DD]` (`src/lib/analytics/backfill.ts`, script added additively to
`apps/api/package.json`). `--to` defaults to today (UTC). Calls
`materializeDay` for every day in the range in order, then
`refreshMvKpiDaily` once at the end. Idempotent and safe to re-run over an
overlapping range. See §11 for the snapshot-metric caveat when backfilling
far in the past.

---

## 9. Endpoint reference

Every route is a full absolute path (this codebase's `fastify-plugin`
module convention — see `apps/api/SKELETON_READY`), uses
`fastify.withTypeProvider<ZodTypeProvider>()`, and validates with Zod
schemas from `@sl/shared`'s `schemas/analytics.ts`.

### User-facing — `modules/analytics` (auth: bearer/cookie session, `fastify.authenticate`; always scoped to `request.authUser.id`)

| Method & path | Query | Notes |
|---|---|---|
| `GET /api/v1/analytics/me/overview` | — | Lifetime profit/coins/snipes, last-7d/30d net profit & snipes, active device count, lifetime snipe success rate. |
| `GET /api/v1/analytics/me/profits` | `from`, `to`, `granularity` | §3, scoped to the caller. |
| `GET /api/v1/analytics/me/activity` | `from`, `to`, `granularity`, `tz` | §4, scoped to the caller. |

### Admin — `modules/admin-analytics` (auth: `fastify.requirePermission('analytics.read')`)

| Method & path | Query | Notes |
|---|---|---|
| `GET /api/v1/admin/analytics/overview` | `from`, `to`, `granularity`, `tz` | §2 KPI overview. |
| `GET /api/v1/admin/analytics/profits` | `from`, `to`, `granularity`, `tz` | §3 platform series + lifetime summary. |
| `GET /api/v1/admin/analytics/profits/leaderboard` | `from`, `to`, `limit` (1–100, default 10), `order` (`top`\|`least`) | §3 leaderboard. |
| `GET /api/v1/admin/analytics/activity` | `from`, `to`, `granularity`, `tz` | §4, platform-wide. |
| `GET /api/v1/admin/analytics/subscriptions` | `from`, `to`, `granularity`, `tz` | §5. |
| `GET /api/v1/admin/analytics/feature-usage` | `from`, `to` | §6. |
| `GET /api/v1/admin/analytics/extension` | `from`, `to` | §6. |
| `GET /api/v1/admin/analytics/errors` | `from`, `to` | §6. |
| `GET /api/v1/admin/analytics/performance` | — | §6, real-time. |

Rate limiting: every route above falls under the global default
(`RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS`, per IP —
`plugins/rate-limit.ts`); none of them are hot enough (admin-only, no
per-user list pagination) to need a stricter per-route override.

---

## 10. Reports / exports

`GET /api/v1/admin/analytics/reports/{kpi,profits,activity}?from=&to=&
format=json|csv` (same `analytics.read` permission). `format` defaults to
`json`.

- **`json`**: `{ items: [...] }`, one row per UTC day in `[from, to]`
  (`kpi` report is a single summary row today — see below).
- **`csv`**: `text/csv; charset=utf-8`, `Content-Disposition: attachment;
  filename="<report>-report-<from>-to-<to>.csv"`, **streamed** via
  `lib/analytics/csv.ts`'s `csvStream()` — a Node `Readable` built from an
  async generator that yields the header line and then one line per row,
  handed straight to `reply.send()` (chunked transfer encoding). The
  response is never buffered into one in-memory string before sending.
- **`profits`**/**`activity`** reports are always day-granularity series
  (`lib/analytics/profits.ts#getPlatformProfitSeries` /
  `lib/analytics/activity.ts#getActivitySeries` with `granularity: 'day'`),
  one CSV row per day. **`kpi`** report is a single row summarising
  `[from, to]` (total/active users, revenue, MRR/ARR, conversion rate,
  churn rate, extension installs) — a per-day KPI report is a natural
  future extension (materialise-then-export from `analytics_daily`) not
  built in this pass.
- **Every export writes an `audit_logs` row** before the response starts
  sending: `actorType: 'admin'`, `actorId` = the calling admin's `users.id`,
  `action: 'analytics.export'`, `entityType: 'analytics_report'`,
  `entityId: null` (no single target entity), `after: { report, from, to,
  format }` — via the skeleton's `recordAudit()` helper
  (`src/lib/audit.ts`), same convention as every other admin mutation.

---

## 11. Known limitations

- **Timezone**: bucket-boundary math is UTC-only (§7). `tz` is accepted by
  every schema but not yet applied to boundaries.
- **`mrr_cents`/`arr_cents`/`plan_mix`/`past_due_count` are point-in-time
  snapshots**, not day-accurate historical reconstructions — `subscriptions`
  is a single mutable-state table with no history log, so a materialised
  row for a past day reflects subscription state *as of when the job ran*,
  not as of that historical day. Re-running `analytics.daily`/
  `analytics.hourly` every day keeps them fresh going forward; a backfill
  run long after the fact will show "now"'s snapshot under every past day's
  row for these four metrics specifically (every other materialised metric
  is a true historical aggregate over that day's rows and is unaffected).
- **`online_users` is not materialised** — Redis presence has no historical
  dimension (`SCARD` only ever answers "right now"), so there's nothing
  meaningful to backfill.
- **Conversion/churn read the whole `subscriptions` table into the
  application** (`kpi.ts#getConversion`/`getChurn`) rather than aggregating
  in Postgres, since the formulas need row-by-row timestamp comparisons
  that don't reduce cleanly to a `GROUP BY`. Fine at MVP scale; the first
  place to optimise if `subscriptions` grows large is pushing the
  `created_at <= from` / cancellation-timestamp filters into the query
  instead of fetching every row.
- **Feature usage** (`lib/analytics/features.ts`) similarly fetches every
  `user_activity` row in range and filters `metadata->>'feature'` in the
  application, rather than a `WHERE metadata ? 'feature'` + `GROUP BY` in
  Postgres — same "correct now, first thing to optimise at scale" trade-off.
- **CSV reports are day-granularity only** (no week/month/lifetime export),
  and the `kpi` report is one summary row rather than a per-day series —
  both are straightforward additions once a real dashboard consumer asks
  for them.
- **Performance percentiles reset on process restart** (in-memory
  `prom-client` registry, no persistence) and are approximate by
  construction (§6) — for a durable, exact latency history, a real metrics
  backend (Prometheus + `histogram_quantile` over scraped data, per
  `docs/11-devops.md`'s monitoring stack) is the intended long-term source,
  not this endpoint.
