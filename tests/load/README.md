# tests/load

k6 load tests for The Sniper's Ledger's API (`apps/api`). Canonical scripts
live in [`scenarios/`](./scenarios); [`lib/config.js`](./lib/config.js) is
the shared base URL/profile/threshold config every scenario imports.
See [`docs/12-testing.md`](../../docs/12-testing.md) "Load" for how this
fits the overall test strategy, coverage targets and release gate.

## Scenarios

| Script                        | Exercises                                  | Notes                                                                                                  |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `auth-login-refresh.js`       | `POST /auth/login` -> `POST /auth/refresh` | One fixed device fingerprint per pooled user (see the script's own comment — trial device limit is 1). |
| `activity-ingest.js`          | `POST /activity/batch`                     | A 2-event batch (heartbeat + search) per iteration.                                                    |
| `extension-heartbeat.js`      | `POST /extension/heartbeat`                | Needs each user's `deviceId` (captured by `setup/provision.mjs`).                                      |
| `admin-analytics-overview.js` | `GET /admin/analytics/overview`            | One shared, really-TOTP-enrolled admin session.                                                        |
| `profits-queries.js`          | `GET /profits`                             | Rotates `daily`/`weekly`/`monthly`/`lifetime` across iterations.                                       |

## Installing k6

```bash
mkdir -p .tools
curl -sSL -o /tmp/k6.tar.gz \
  "https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz"
tar -xzf /tmp/k6.tar.gz -C /tmp
cp /tmp/k6-v0.55.0-linux-amd64/k6 .tools/k6 && chmod +x .tools/k6
.tools/k6 version
```

`.tools/` is gitignored (repo convention — see `docs/11-devops.md`'s
actionlint/hadolint setup). `run.mjs` looks for the binary at `$K6_BIN`,
then `.tools/k6` (repo root), then `k6` on `PATH`; if none exist it falls
back to a minimal `autocannon`-based runner
([`autocannon-fallback.mjs`](./autocannon-fallback.mjs)) that covers the
same endpoints with the same smoke thresholds, at the cost of k6's
staged-ramp support — see that file's header. Prefer installing k6.

## Running

Everything needs a running `apps/api` (and its Postgres/Redis) — this is a
load test of the real server, not a mock. Point it at whichever instance
you want with `LOAD_BASE_URL` (default `http://127.0.0.1:3100`, matching
`tests/e2e`'s own API port so the two suites never collide on a port —
see `tests/e2e/playwright.config.ts`).

```bash
# one API instance to point the load test at (any of these work):
#   - tests/e2e's own webServer (leave it running from a prior `pnpm --filter @sl/tests test:e2e`)
#   - `pnpm --filter @sl/api dev` (dev DB, default port 3000 — then set LOAD_BASE_URL=http://127.0.0.1:3000)
#   - a dedicated instance against its own test database

cd tests
LOAD_BASE_URL=http://127.0.0.1:3100 pnpm load:smoke   # provisions fixtures, then runs every scenario at the smoke profile
pnpm load:soak     # LOAD_SOAK_DURATION env overrides the default 30m
pnpm load:stress
```

`load:smoke`/`load:soak`/`load:stress` are `node load/run.mjs <profile>`
under the hood; pass scenario names to run a subset:

```bash
node load/run.mjs smoke auth-login-refresh profits-queries
```

Each run provisions a fresh pool of fixture users (`setup/provision.mjs` —
skip with `LOAD_SKIP_PROVISION=1` to reuse the last run's
`.artifacts/fixtures.json`, e.g. when iterating on one scenario script) and
writes one JSON summary per scenario to `load/.artifacts/<profile>-<scenario>.json`
(k6's own `--summary-export`, or the fallback runner's equivalent shape).

## Profiles

- **smoke** (default; the only profile CI runs — see `docs/12-testing.md`
  "CI runs everything but load"): 3 VUs, 30s. A quick "did I just break
  something obvious" check, not a capacity test.
- **soak**: 20 VUs for 30 minutes by default (`LOAD_SOAK_DURATION` to
  change). Looks for degradation over time — a growing p95, a rising error
  rate, connection-pool exhaustion — not a peak number.
- **stress**: ramps 20 -> 100 -> 200 VUs over ~8 minutes then back to 0.
  Finds the actual breaking point and checks it fails the right way (429s
  and clean recovery once load drops, not a crash or corrupted data).

## Thresholds

Defined in `lib/config.js`'s `thresholds()`, overridable per scenario. As
shipped:

| Profile | p95 `http_req_duration` | error rate |
| ------- | ----------------------- | ---------- |
| smoke   | < 800ms                 | < 1%       |
| soak    | < 1200ms                | < 2%       |
| stress  | < 2500ms                | < 10%      |

A scenario tightens or loosens these for its own endpoint (see each
script's `thresholds({...})` call) — `extension-heartbeat.js` and
`auth-login-refresh.js` expect to be cheap (<600–800ms even under smoke);
`admin-analytics-overview.js` is allowed more room (<1500ms) since it
aggregates across the whole platform.

## Interpreting results

- A **failed threshold** on `smoke` is a release blocker (see
  `docs/12-testing.md`'s release-gating checklist) — something regressed
  badly enough to be visible at 3 VUs.
- A **failed threshold** on `soak`/`stress` alone (smoke still green) is a
  capacity/scaling finding, not necessarily a release blocker — record it
  in `docs/12-testing.md` "Defects found" with the numbers and let a human
  decide whether it blocks this particular release.
- k6's own summary (`--summary-export` JSON, or the console table) reports
  `http_req_duration{p(95)}`/`http_req_failed{rate}` per scenario, plus the
  named `check()`s (e.g. `activity-ingest.js`'s `"accepted >= 1"`) — a check
  failing while the request itself still returns 200 usually means the
  response _shape_ changed, worth investigating even if it didn't trip a
  threshold.

## Local smoke run — recorded numbers

See `docs/12-testing.md` "Load" for the numbers from the most recent local
smoke run (profile `smoke`, 3 VUs, 30s per scenario, against a locally
running `apps/api` on the dev database) and any defects it turned up.
