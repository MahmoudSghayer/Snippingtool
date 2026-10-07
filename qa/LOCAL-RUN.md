# Nova Trade QA — running from a LOCAL session

Use this when the Claude Code session runs **on your own machine** (Claude Desktop
app, or `claude remote-control` in the repo). A local machine reaches production
and your real Chrome directly, so there is **no network allowlist to configure** —
unlike the cloud environment. Everything (`qa/` harness, the F1–F8 fixes, the
report, `qa/PROD-RUN.md`) is already on branch `claude/serene-tesla-ztui62`.

Two complementary ways to test, below. Do either or both. All the production
guardrails in `qa/PROD-RUN.md §3` still apply, and cleanup (`§4`) is still required.

---

## A. Headless harness (real Chromium, no extension)

Drives a fresh Chromium against live production with the committed Playwright suite.

```bash
# from the repo root
corepack enable
pnpm install

# Provide the test accounts as env vars (values from your side, never commit them).
export QA_USER1_EMAIL=... QA_USER1_PASSWORD=...
export QA_USER2_EMAIL=... QA_USER2_PASSWORD=...
export QA_ADMIN_EMAIL=... QA_ADMIN_PASSWORD=... QA_ADMIN_TOTP_SECRET=...

cd qa
QA_TARGET=prod npx playwright test -c playwright.config.ts
```

- Locally, Playwright uses its own managed Chromium — you don't need the
  `/opt/pw-browsers/chromium` path the cloud config assumes. If Playwright reports
  no browser, run `npx playwright install chromium` once, or set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE`/the config's `executablePath` to your Chrome.
- Account requirements (same as `qa/PROD-RUN.md §0`): verified emails; admin has
  TOTP enrolled and `QA_ADMIN_TOTP_SECRET` is that base32 secret; trial device
  limit is 1 (the harness logs in once per identity).
- Output: `qa/out/audit-log.jsonl`, `qa/out/html-report/`, `qa/out/screens/`
  (secrets are redacted).

## B. Claude in Chrome (your real, logged-in browser)

Use the Claude for Chrome extension to exercise the app as yourself — this is the
path for anything that needs your real session, including the **EA FC 27 web app**
where the Nova Trade extension injects (the harness can't reach that; it's EA's page).

Preconditions:
- Chrome open, Claude for Chrome extension enabled, and you signed in to Nova Trade.
- For the in-page bot, the Nova Trade browser extension/userscript installed per the
  dashboard's Extension page (Account → Extension) and your EA FC 27 web app open.

Ask the local session to:
1. Open a new tab (not your working tabs) and go to `https://snippingtool-eta.vercel.app`.
2. Sign in, then walk the customer surface: account sections, pass/trial, extension
   download + userscript link, devices, the security card (change password / 2FA /
   delete-account confirmation — do NOT confirm delete on a real account), and the
   PayPal claim form (submit at most 2 labelled "QA TEST – ignore", then reject them
   from the admin side).
3. As the QA admin, open each `/admin/*` page read-only; perform mutations only on
   the QA accounts' own subscriptions / payment claims / flags. Do **not** touch the
   kill switch, feature toggles, `/admin/config`, plans or coupons on production.
4. EA FC 27 web-app flow: open the EA FC Ultimate Team web app, confirm the Nova
   Trade "Nova AI" bot page injects, the popup signs in with 2FA, bootstrap/heartbeat
   succeed, and the kill switch propagates. Observe only — do not place real market
   actions beyond what the product normally does in a dry run.

Capture console/network via the extension's tools; note anything broken.

## C. Production-specific confirmations (the point of going live)

- **F8 — `/metrics` must be 404 at the edge** once the Caddy change is deployed:
  `curl -sS -o /dev/null -w "%{http_code}\n" https://api.46.62.142.29.sslip.io/metrics`
  → **404** expected. `200` with Prometheus text = Caddy block not deployed yet.
- Real security headers / TLS / HSTS / CSP at the Vercel + Caddy edge.
- Real-network performance (TTFB/LCP) — the local-replica numbers were on-box.
- Confirm the F1–F7 fixes behave once deployed (they ship with the API release;
  pushing the branch alone does not deploy — release runs on `main` / `vX.Y.Z` tags).

## D. After the run

- Cleanup per `qa/PROD-RUN.md §4`: delete the throwaway account, revoke QA
  devices/sessions, reject the QA payment claims; log every production mutation to
  `qa/out/prod-mutations.log`.
- Update `qa/REPORT.md` and `qa/out/findings.json` with prod-only findings and the
  confirmed F8 status, commit on `claude/serene-tesla-ztui62` with the same
  attribution trailers as the existing commits, and push. No pull request unless asked.
