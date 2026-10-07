# Nova Trade — Production QA & Security Audit

**Product:** Nova Trade (internal "Sniper Ledger") — React 19 dashboard (Vercel), Fastify API (Postgres/Redis/BullMQ), Chrome MV3 extension + userscript.
**Audit date:** 2026-10-07
**Auditor:** Automated QA/security/performance/UX sweep via Playwright browser automation + API-level verification.
**Branch:** `claude/serene-tesla-ztui62`

---

## 0. Scope, method and an important caveat

The audit was run against a **full local replica of the production stack**, not the live site. The audit environment's network policy blocked the production hosts (`snippingtool-eta.vercel.app`, `api.46.62.142.29.sslip.io` → 403 at the proxy) and no production test-account credentials were available, so the production pass could not run. To test like a real customer anyway, the entire stack was stood up in the container **in production mode** (`NODE_ENV=production`, Postgres with TLS, Redis TLS-only, the real built dashboard served behind a proxy that mirrors `vercel.json`'s headers/CSP/rewrites, a local mail catcher) and driven through a real Chromium browser.

**What this means for the findings:**
- Logic, auth, authorization, input-handling, CRUD and client behaviour reproduce faithfully on the replica — those findings apply to production too.
- **Edge/infra-specific** items (whether `/metrics` is publicly reachable, real TLS/HSTS at the edge, geographic latency, and how the live Caddy/Vercel chain sets forwarded-for headers) are marked **needs-prod-verify** and must be confirmed against the live host.

A reusable harness ships in `qa/` (`QA_TARGET=prod|local`) so the production pass is one command away once the two hosts are allow-listed and `QA_*` credentials are provided.

**Coverage executed (55 browser tests + API-level checks, all green):** public/marketing pages, registration/login/TOTP/reset flows and their validation, the customer account area, **all 14 admin pages** + command palette, HTTP-layer security (headers/CSP, cookie flags, CSRF, mass-assignment, IDOR between two accounts, `/metrics`), passive performance, axe accessibility, mobile responsiveness, and edge cases (double-submit, offline, deep links, malformed input).

---

> **Update (2026-10-07, follow-up round):** all remaining findings have since been fixed on the same branch (F3–F8), each with a regression test, and F9 was re-measured and **withdrawn as a measurement artifact** (recharts does not load on the auth pages). Full suites pass: `@sl/api` 489/489, `@sl/security-tests` 191/191, `qa/` browser 56/56; lint and typecheck clean. The only item still requiring action is deploying the F8 Caddy change and confirming `/metrics` returns 404 on the live host. Per-finding status is in §3–§6 and `qa/out/findings.json`.

## 1. Executive summary

**Overall score: 86 / 100** (assessed with the two High-severity issues fixed; **80 / 100** as originally found). With the full follow-up round now applied, the remaining Medium/Low items are closed in code too — see the update note above.

Nova Trade is a well-engineered product with security fundamentals that are clearly deliberate: argon2id password hashing, EdDSA JWTs with short TTLs, mandatory TOTP for admins, refresh-token rotation **with reuse detection**, account lockout with exponential backoff, a strict permission matrix enforced server-side, strict request schemas (no mass-assignment), signed double-submit CSRF, a restrictive CSP, and an append-only audit log. Authorization scoping (IDOR) and mass-assignment were specifically probed and found **sound**. Accessibility scans came back clean on every public page. No functional crashes or broken flows were found across the pages exercised.

The audit found **2 High**, **3 Medium** and **4 Low** issues. Both High issues were the same class — rate-limit / IP-ban **evasion** — and are **fixed on this branch with regression tests**. The remaining items are hardening opportunities, not active breaches.

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | — |
| High | 2 | ✅ both fixed (F1, F2) |
| Medium | 3 | ✅ F3, F4 fixed; F8 fixed in code, Caddy change deploy-gated |
| Low | 4 | ✅ F5, F6, F7 fixed; F9 withdrawn (not reproduced) |

### Score breakdown
| Area | Score | Notes |
|---|---|---|
| Security | 83/100 | Strong core; two evasion bugs (fixed), session-revoke latency, enumeration, `/metrics` edge exposure to confirm |
| Functionality | 95/100 | All pages load and behave; one minor feature-gate inconsistency |
| Performance | 85/100 | Clean; chart bundle shipped to auth pages; needs real-network numbers |
| UX / Accessibility | 92/100 | axe-clean, keyboard-reachable, good empty/confirm states |
| Reliability / edge | 90/100 | Double-submit, offline and deep-link handling all graceful |

---

## 2. Critical issues

**None.** No issue allows account takeover, data exfiltration, privilege escalation or data loss.

---

## 3. Security report

### 3.1 High — fixed on this branch

**F1 — IP spoofing via `X-Forwarded-For` → ban & rate-limit evasion.**
`Fastify({ trustProxy: true })` trusted every proxy, so any client could set `request.ip` to an arbitrary value with a forged `X-Forwarded-For`. Because `request.ip` keys the global and per-IP login limiters and the IP-ban checks, a rotating XFF minted a fresh bucket per request (never 429) and, in production, would evade IP bans. **Verified:** 9 requests with rotating XFF from one socket never tripped a global limit of 5, while a fixed IP tripped at the 6th.
**Fix (commit `ee03f7b`):** trust only configured upstream proxies via a new `TRUSTED_PROXY` env (default `loopback, linklocal, uniquelocal` — a reverse proxy on the same host/private network); a request from an untrusted public peer has its XFF ignored. A bare `true` opts back in for unusual topologies. Regression-tested.

**F2 — Global rate-limit bypass via forged, unverified JWT `sub`.**
The rate-limiter `keyGenerator` base64-decoded the access-token payload **without verifying its signature** and keyed on `ip:sub`. An unsigned token with a rotating `sub` minted a fresh bucket per request from a single IP, so the global limit never tripped. **Verified:** 9 requests with rotating forged `sub` from one IP never tripped a global limit of 5; a fixed `sub` tripped at the 6th.
**Fix (commit `ee03f7b`):** the keyGenerator now calls `verifyAccessToken`; only a signature-verified `sub` contributes to the key, otherwise it falls back to the per-IP key. Regression-tested.

> F1 and F2 compounded: together they let one host defeat the global limiter and the per-IP login throttle, materially weakening brute-force resistance for an attacker who already holds a password. Both are now closed.

### 3.2 Medium — all fixed on this branch

**F3 (fixed) — Targeted session/device revoke didn't invalidate the live access token.** Revoking a single session (`DELETE /sessions/:id`) or device revokes the refresh token but not the already-issued access token, which keeps working until its TTL (15 min user / 5 min admin) because `resolveAuthUser` never checks the session's `revokedAt`. Logout-all, password change and admin force-logout *are* immediate (they bump `row_version`); only the single-target revoke is delayed. **Fix:** check `sessions.revokedAt` by `claims.sid` in `resolveAuthUser`, or bump `row_version` on single revoke.

**F4 (fixed) — User enumeration on `POST /auth/register`.** A duplicate email returns `409 "An account with this email already exists"`, disclosing registered emails — inconsistent with the deliberately non-revealing reset/resend flows. **Fix:** return the neutral success shape and notify the existing account by email out of band.

**F8 (fixed in code; Caddy deploy-gated) — `/metrics` unauthenticated + label cardinality.** The endpoint serves full Prometheus metrics with no auth. On the replica this is by design (no edge in front); on production it is public **iff** Caddy forwards `/metrics` to the world — confirm against the live host. Related: the metrics label falls back to `request.url` for unmatched routes, so random 404 URLs can grow label cardinality unboundedly. **Fix:** restrict `/metrics` to the monitoring network at Caddy (or require a scrape token) and cap/normalise the route label.

### 3.3 Low — all fixed on this branch

- **F6 (fixed) — Weak TOTP recovery-code entropy.** Codes derive from 5 random bytes, case-collapsed and 0-padded to 8 chars — usable entropy well under the 8-char format implies. Mitigated by argon2 hashing + single-use + 8 attempts/ticket. **Fix:** draw from a fixed alphabet with rejection sampling; don't pad.
- **F7 (fixed) — `/auth/refresh` and `/auth/logout` skipped CSRF.** Low impact in the production same-origin (`/api` rewrite) topology with `SameSite=lax`; becomes relevant if the API is used cross-site with `SameSite=none`. **Fix:** add `verifyCsrf`, or document the same-origin assumption.

### 3.4 Verified sound (no action)
IDOR scoping (devices/sessions/notifications/filters/trades/payment-claims/risk-events/licenses all scope by the authenticated user id — a cross-user device delete returns 404 and leaves the victim's data intact), mass-assignment (all request schemas `.strict()`, privileged fields written only via explicit field maps), CSRF double-submit (signed cookie + constant-time compare), refresh rotation/reuse detection, password-change/reset global invalidation, cookie attributes (`httpOnly` on `sl_at`/`sl_rt`, `SameSite` set, `Secure` forced with `SameSite=none`), and the security-header/CSP set.

---

## 4. Performance report

Absolute timings were measured on-box (API p50 a few ms, page load < 500 ms) and are **not representative of production** latency or geography — they only establish that nothing is pathologically slow locally. Re-measure on production with Lighthouse/WebPageTest.

- **F9 (withdrawn — not reproduced) — Auth pages were suspected to ship a chart bundle they don't use.** Re-measuring a cold `/login` in a real browser showed the recharts chunk does **not** load (0 chart JS); routes are already lazy-loaded (`lazyRouteComponent`) and `@sl/ui/charts` is kept out of the `@sl/ui` barrel. The original ~365 KB figure was a measurement artifact in the perf spec (it summed a transiently-prefetched chunk). The main entry bundle is ~468 KB, which is acceptable; splitting it further is a nice-to-have, not a defect. No change made.
- The static marketing landing page ships no SPA JS (good).
- API calls observed during account load were 2 requests, both < 15 ms locally.

**Load testing** was intentionally **not** run against production (the brief forbids it); the repo's k6 scenarios (`tests/load`) should be run against staging.

---

## 5. UX & accessibility report

- **axe-core (WCAG 2 A/AA) found no serious or critical violations** on `/`, `/login`, `/register`, `/forgot-password`, `/terms`, `/refund-policy`.
- Login form is keyboard-reachable; focus lands on an interactive element.
- The 404 route renders a real not-found state (not a blank/crash); deep-linking a protected route while signed out bounces to `/login`.
- Destructive actions are gated: delete-account opens a password-confirmation dialog rather than deleting on click.
- Admin command palette opens on `Cmd/Ctrl+K`.
- All 14 admin pages render their shell with no uncaught console errors.

No UX blockers found. Minor recommendation: the register page's validation and the account security section are clear; consider surfacing the "email already registered" case as a sign-in nudge once F4 is addressed (so the UX stays helpful without the enumeration leak).

---

## 6. Functional report

Every page exercised loaded and behaved correctly; no broken flows, dead ends or crashes were observed across public pages, the account area and all admin pages. One inconsistency:

- **F5 (fixed) — Trade totals/export skipped the feature-gate `/trades` enforces.** A user whose plan lacks `ledger.recorder` gets `403` on `/trades` but `200` on `/trades/totals` and `/trades/export.csv` (own data only — not IDOR). **Fix:** gate those two endpoints consistently, or document them as always-available.

---

## 7. Prioritised recommendations roadmap

All code fixes are complete on branch `claude/serene-tesla-ztui62`. What remains is deployment + production verification.

1. **Critical fixes** — none.
2. **High priority** — ✅ done: F1 (XFF trust), F2 (forged-sub rate-limit key).
3. **Medium priority** — ✅ done: F3 (immediate session-revoke), F4 (register enumeration), F8 (metrics label capped + Caddy `/metrics` 404). **F8's Caddy change needs a deploy, then confirm `curl https://<api-host>/metrics` → 404.**
4. **Low** — ✅ done: F5 (feature-gate consistency), F6 (recovery-code entropy), F7 (CSRF on refresh/logout). F9 (chart bundle) **withdrawn** — re-measurement showed recharts does not load on the auth pages; it was a perf-spec measurement artifact, not a defect.

**Deploy note:** pushing this branch does not deploy (release runs on `main`/tags). The API fixes take effect on the next deploy; the Caddy change ships with the infra deploy and must then be verified on the live host.

### Still to do (needs your action)
- **Production pass:** allow-list `snippingtool-eta.vercel.app` and `api.46.62.142.29.sslip.io` in the environment's Network settings and provide `QA_*` test-account secrets; then `QA_TARGET=prod` runs the same suite against the live site. This will confirm F8 and gather real performance numbers.
- **Chrome route (alternative):** to drive your own logged-in Chrome, run the session on your machine (Claude Desktop or `claude remote-control`) — a cloud session cannot reach your local browser.

---

## 8. Fix verification (this branch)

- New regression tests `tests/security/src/proxy-trust-rate-limit.test.ts` **fail against the pre-fix code** and **pass after the fix** (verified by temporarily reverting the built output).
- Full suites green after the fixes: `@sl/api` 485/485, `@sl/security-tests` 182/182; lint and typecheck clean.
- Browser audit: 55/55 Playwright tests pass against the local production-mode stack.

### Follow-up round (F3–F9)
- New regression tests: `session-revoke` (F3), `register-enumeration` (F4), `trades-feature-gate` (F5), `recovery-codes` (F6, unit), `refresh-logout-csrf` (F7), `metrics-label` (F8, unit). F3/F7 were confirmed to fail against the pre-fix code.
- After the fixes: `@sl/api` 489/489, `@sl/security-tests` 191/191, `qa/` browser 56/56; lint + typecheck clean.
- F9 withdrawn after re-measurement (see §4). F8's Caddy change is the only item awaiting a deploy + live `/metrics` check.

Machine-readable findings: `qa/out/audit-log.jsonl` (regenerated from `qa/out/findings.json`).
