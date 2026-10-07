# Production QA audit — run sheet

Self-contained instructions for running the `qa/` audit against **live production**
(`https://snippingtool-eta.vercel.app`, API `https://api.46.62.142.29.sslip.io`).

The harness, fixes and report are already on branch `claude/serene-tesla-ztui62`.
This file exists because the production pass needs environment settings that
only take effect in a **new** session.

## 0. Prerequisites (one-time, in the cloud environment settings)

Set these from the session title bar → cloud environment menu → **Edit**, then
start a **fresh** session (settings apply at session start, not mid-session):

1. **Network access** → choose the **Limited** level (older app: **Custom**),
   then under **Allowed domains** add — keeping "Allow package managers" ticked:
   - `snippingtool-eta.vercel.app`
   - `api.46.62.142.29.sslip.io`
2. **Secrets** (same Edit screen) — values entered in settings, never in chat:
   - `QA_USER1_EMAIL`, `QA_USER1_PASSWORD`
   - `QA_USER2_EMAIL`, `QA_USER2_PASSWORD`
   - `QA_ADMIN_EMAIL`, `QA_ADMIN_PASSWORD`, `QA_ADMIN_TOTP_SECRET`

Account requirements:
- All accounts have a **verified email** (prod blocks login before verification).
- The admin has **TOTP already enrolled**; `QA_ADMIN_TOTP_SECRET` is that
  authenticator secret (base32), so the harness can generate codes.
- The trial plan allows **1 device** — if an account is used elsewhere, logins
  may hit the device limit. The harness logs in once per identity to minimise this.

## 1. Verify the environment is ready

```bash
# Both should be < 400 (not 000 / 403), and the count should be 7.
curl -sS -o /dev/null -m 15 -w "vercel %{http_code}\n" https://snippingtool-eta.vercel.app/
curl -sS -o /dev/null -m 15 -w "api    %{http_code}\n" https://api.46.62.142.29.sslip.io/health/live
env | grep -cE '^QA_(USER1|USER2|ADMIN)'
```

If the hosts 403 or the count is 0, the settings have not taken effect — confirm
they are saved and that this is a session started **after** saving them.

## 2. Install and run

```bash
corepack enable
pnpm install --frozen-lockfile

cd qa
# Full suite (desktop + mobile projects) against production:
QA_TARGET=prod npx playwright test -c playwright.config.ts

# Or the live Chromium is pre-installed at /opt/pw-browsers/chromium (the config
# already points there). Narrow while smoke-testing:
#   QA_TARGET=prod npx playwright test -c playwright.config.ts 00-smoke 04-security
```

Results: `qa/out/audit-log.jsonl` (findings), `qa/out/html-report/` (Playwright
report), screenshots under `qa/out/screens/`. Secrets are redacted in the log.

## 3. Production guardrails (do NOT skip)

- **Scope:** only the two hosts above; only the QA accounts, plus at most one
  freshly-registered throwaway account to exercise the sign-up form.
- **No load/stress testing on production.** Performance is passive only
  (Navigation Timing / resource sizes). k6 (`tests/load`) runs against staging, never prod.
- **Rate limit / lockout:** exercise only against a QA account, and stop as soon
  as the limit/lockout is observed. The login limit is 20/15 min per IP+account.
- **Global/destructive admin actions stay on the local stack** (kill switch,
  feature toggles, `/admin/config`, plan create/archive, coupon changes). On prod
  the admin pages are opened read-only; mutations are limited to the QA accounts'
  own subscriptions / payment claims / flags.
- **Payment claims:** at most 2, labelled "QA TEST – ignore", then rejected by the
  QA admin.
- **Probes** use benign marker strings only — nothing that alters or exfiltrates data.
- **IDOR** checks run only between `QA_USER1` and `QA_USER2`.

## 4. Cleanup after the run

- Delete the throwaway self-registered account (Account → Security → Delete account).
- Revoke the QA devices and sessions created during the run (Account → Devices;
  admin force-logout if needed).
- Reject the QA payment claims from the admin Payments page.
- Log every production mutation in `qa/out/prod-mutations.log` as you go.

## 5. What to confirm on production specifically

These couldn't be verified on the local replica and are the point of the prod run:

- **F8 — `/metrics` must be 404 at the edge** once the Caddy change is deployed:
  `curl -sS -o /dev/null -w "%{http_code}\n" https://api.46.62.142.29.sslip.io/metrics`
  → expect **404** (if it returns 200 with Prometheus text, the Caddy block is not
  deployed yet). Health endpoints (`/health/live`) stay public.
- **Security headers / TLS / HSTS** on the real edge (Vercel + Caddy), CSP honoured.
- **Real-network performance** (TTFB/LCP) — the local numbers are on-box and not
  representative.
- That the F1–F7 fixes behave as expected once deployed (they ship with the API
  release; pushing the branch alone does not deploy — release runs on `main`/tags).

Then update `qa/REPORT.md` / `qa/out/findings.json` with any prod-only findings
and the confirmed status of F8.
