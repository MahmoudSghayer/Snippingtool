# 06 — Extension

Status: implementation-ready for PHASE 6 (extension core logic). Builds on
[`01-architecture.md`](./01-architecture.md), which this document expands
one level — read that first for the component/deployment/sequence diagrams;
this one is the extension's own reference: file layout, the two build
targets, the day-one verification checklist for `main/adapter.ts`'s assumed
shape, the safety governor's exact thresholds and math, the itemised "What
it sends" list, crash recovery, auto-update, error reporting, settings
conflict rules, and security notes.

## Contents

1. [Layout and worlds](#1-layout-and-worlds)
2. [Message flows](#2-message-flows)
3. [Build targets](#3-build-targets)
4. [The ASSUMED SHAPE and the day-one verification checklist](#4-the-assumed-shape-and-the-day-one-verification-checklist)
5. [Safety governor: thresholds and math](#5-safety-governor-thresholds-and-math)
6. [Telemetry — "What it sends"](#6-telemetry--what-it-sends)
7. [Crash recovery](#7-crash-recovery)
8. [Auto-update](#8-auto-update)
9. [Error reporting](#9-error-reporting)
10. [Settings sync conflict rules](#10-settings-sync-conflict-rules)
11. [Security notes](#11-security-notes)
12. [Testing](#12-testing)

---

## 1. Layout and worlds

```
src/
  main/adapter.ts        MAIN world. The only file that knows EA's internals.
  content/
    index.ts              ISOLATED world orchestrator — the engine loop lives here.
    adapter-client.ts      ISOLATED-world caller into the MAIN-world act surface.
  engine/
    ranker.ts              Opportunity scoring + filter rotation/retirement.
    governor.ts             Safety budget — every act() call goes through allow().
    assist.ts                M2: keyboard-driven filter cycling + human-confirmed buy.
    autobuyer.ts              M3: automated attempt loop. ledger-auto build ONLY.
    autobuyer-loader.{ledger,auto}.ts   Build-time exclusion switch — see §3.
    types.ts                Lightweight attempt/trade shapes shared by assist/autobuyer.
  background/
    index.ts                Service worker entry: message routing + chrome.alarms only.
    auth.ts / license.ts / settings.ts / telemetry.ts / errors.ts / update.ts
  lib/
    api.ts        Bearer + single-flight refresh-on-401 + backoff + x-request-id.
    auth.ts        register/login/mfa/logout/refresh, owns where tokens live.
    http.ts         Shared retry/backoff primitive (api.ts and auth.ts both use it).
    license.ts       Bootstrap/heartbeat + signed entitlement cache + 24h offline grace.
    settings.ts       Read-through cache over the user settings document.
    telemetry.ts       Batched queues + flush, opt-out honoured here.
    errors.ts           Flushes the logger's ring buffer to /extension/errors.
    fingerprint.ts        Stable non-PII device fingerprint hash.
    storage.ts             storage.local/.session wrappers + AES-GCM at rest.
    logger.ts               In-memory ring buffer + export.
    bg-client.ts              Typed chrome.runtime.sendMessage wrapper (popup/options/content).
  model/prices.ts   Ported verbatim from milestone 1 — simple statistics, no ML.
  store/db.ts        IndexedDB observation store — local only, never uploaded.
  ui/panel.ts          Shadow-DOM readout: card, sparkline, session P&L, risk meter, ranker.
  popup/               Status, login/2FA, current card, risk meter, quick toggles.
  options/              Filters editor, budgets/governor bounds, devices, telemetry opt-out,
                          "What it sends", logs export, account/license info.
scripts/
  build.mjs               Programmatic Vite build, both targets — see §3.
  generate-manifest.mjs      Pure manifest-object builder, used by build.mjs.
test/
  model/, engine/, store/    Vitest unit tests (jsdom + fake-indexeddb).
  fixtures/mock-ea-app/       Static page + script replaying recorded UTAS payloads.
  e2e/extension.spec.ts        Playwright, loads dist/ledger against the fixture.
```

**Two worlds, one rule.** `main/adapter.ts` runs in the page's `MAIN` world
(`document_start`) and is the _only_ file in the whole codebase that reads
EA's network traffic or drives EA's service layer. `content/index.ts` (plus
everything it imports — `engine/*`, `ui/panel.ts`, `store/db.ts`, the
messaging helpers) runs in the `ISOLATED` world (`document_idle`) and knows
nothing about EA's internals at all; it only ever talks to the page through
`content/adapter-client.ts`'s typed request/response protocol over
`window.postMessage` (channel `ledger:v2`,
`packages/shared/src/ext-messages.ts`). If EA reshuffles their bundle, only
`adapter.ts` needs to change.

**The service worker owns no loops.** `background/index.ts` is pure message
routing plus three `chrome.alarms` (10-minute license heartbeat, 2-minute
telemetry flush, 5-minute error flush) — never a `setInterval`. Every
long-lived thing (the engine tick, the risk-meter UI tick, the
crash-recovery persistence tick, the watchdog) is a `setInterval` inside
`content/index.ts`, which MV3 does not kill.

## 2. Message flows

Three channels, none of which overlap in purpose:

1. **`adapter.ts` ↔ `content/index.ts`**, `window.postMessage`, channel
   `ledger:v2`. Adapter emits `ready` / `probe` / `shape` / `auctions` /
   `action_result`; content emits `act_request` (`search` / `buy` /
   `readResult`, each carrying a `requestId` the matching `action_result`
   echoes back — see `content/adapter-client.ts`). This is the only
   direction data about EA's internals ever flows, and only the fields
   `trimAuction` copies ever cross it (§11).
2. **`content/index.ts` ↔ `background/index.ts`**, `browser.runtime.sendMessage`,
   typed by `backgroundMessageTypeSchema`
   (`packages/shared/src/ext-messages.ts`). Content sends `record` (raw
   observations, unlimited/local), `telemetry.enqueue` (one batch of one
   kind at a time — `activity` / `sniping` / `trades` / `filterStats` /
   `riskEvents` / `event`), and reads `settings.get` / `filters.list` /
   `license.bootstrap` / `auth.status`. Background never pushes to content
   proactively today (no WS gateway to receive from yet — see the note in
   §8); content polls `license.bootstrap` itself when it needs fresh
   entitlements.
3. **`background/*` ↔ `apps/api`**, HTTPS, via `lib/api.ts`/`lib/auth.ts`.
   The only network egress in the whole extension — `content/index.ts` never
   imports `lib/api.ts`.

## 3. Build targets

Plain multi-entry Vite (programmatic API, `scripts/build.mjs`), not
`@crxjs/vite-plugin`: crxjs pins itself to Vite ≤ 5's plugin hooks and does
not support Vite 6, which is what `packages/config` already standardises the
rest of the monorepo on. `scripts/build.mjs` runs three separate
`vite.build()` calls per target instead of one multi-entry build, because
MV3 content scripts cannot be ES modules (no code-splitting is possible for
them) while the service worker + popup + options page are ordinary ES
modules that benefit from shared chunks:

| Call | Entry                                                                         | Format                     | Output                                                            |
| ---- | ----------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| 1    | `src/main/adapter.ts`                                                         | `lib` (IIFE, single entry) | `adapter.js`                                                      |
| 2    | `src/content/index.ts`                                                        | `lib` (IIFE, single entry) | `content.js`                                                      |
| 3    | `src/background/index.ts` + `src/popup/index.html` + `src/options/index.html` | ES, multi-entry            | `background.js`, `src/popup/index.html`, `src/options/index.html` |

`scripts/generate-manifest.mjs` then writes `manifest.json` from the two
targets' env (`VITE_API_ORIGIN`, `VITE_UPDATE_URL`, the package version).

```
pnpm --filter @sl/extension build:ledger    # dist/ledger      — listable
pnpm --filter @sl/extension build:auto      # dist/ledger-auto — self-hosted
pnpm --filter @sl/extension build           # both
```

|                       | `ledger`                               | `ledger-auto`                  |
| --------------------- | -------------------------------------- | ------------------------------ |
| Contains              | M1 recorder + M2 assist                | M1 + M2 + M3 automation        |
| `name`                | "Sniper's Ledger"                      | "Sniper's Ledger (Automation)" |
| `VITE_AUTOMATION`     | `'0'`                                  | `'1'`                          |
| `update_url`          | absent (Chrome Web Store owns updates) | set from `VITE_UPDATE_URL`     |
| `version_name`        | absent                                 | `"<version>-auto"`             |
| `engine/autobuyer.ts` | **never in the module graph at all**   | included                       |

**How the exclusion is actually guaranteed.** `content/index.ts` imports
`loadAutobuyer` from the bare specifier `virtual:autobuyer-loader`, never
from `engine/autobuyer.ts` directly. `scripts/build.mjs`'s `resolve.alias`
points that specifier at `engine/autobuyer-loader.ledger.ts` (a stub with no
reference to `autobuyer.ts` whatsoever) for the `ledger` target, and at
`engine/autobuyer-loader.auto.ts` (a real, statically-importing loader) for
`ledger-auto`. Because the alias is resolved before Rollup ever builds the
module graph, `engine/autobuyer.ts` is not merely dead code in the `ledger`
build — it is never opened, parsed, or referenced by any chunk. This is
stronger than (and does not rely on) tree-shaking a conditional dynamic
`import()`, which content scripts can't really benefit from anyway (IIFE
format has no code-splitting, so a "lazy" `import()` would just get inlined
regardless of any runtime flag). `import.meta.env.VITE_AUTOMATION === '1'`
is still checked at runtime in `content/index.ts` before `loadAutobuyer()`
is even called, as defence in depth on top of the build-time guarantee.

Verify: `grep -r autobuyer apps/extension/dist/ledger` returns nothing —
covered by `test/e2e/extension.spec.ts`'s `ledger build contents` suite,
which runs even without a browser (a plain filesystem scan).

## 4. The ASSUMED SHAPE and the day-one verification checklist

The live EA FC web app is unreachable while the market is locked, so
`main/adapter.ts`'s act surface (`search`/`buy`/`readResult`, M2/M3 only —
passive observation is unaffected and unchanged from milestone 1) is written
against a **documented assumption**, not observed fact. The full assumption
lives in a comment titled `ASSUMED SHAPE — verify on day one` at the top of
`adapter.ts`; the short version:

- `window.services.Item.repository.search(criteria) -> Promise<{ auctionInfo: [...] }>`
- `window.services.Transfer.repository.buyNow(tradeId) -> Promise<unknown>`
- `window.services.Transfer.repository.bid(tradeId, amount) -> Promise<unknown>`

Every single lookup is guarded (`typeof x === 'function'` before ever
calling it) — a missing or renamed property is a clean `probe()` failure
(`{ ok: false, reason }`), never a thrown exception. `probe()` runs once at
load and again before every act call, so a bundle update mid-session is
caught immediately, not just on the next page load (docs/01-architecture.md
§3.5).

**Day-one checklist**, once the market unlocks and the real web app is
reachable:

1. Open the real FC web app with DevTools open, run `window.services` in the
   console. If it exists with `Item`/`Transfer` sub-objects, check their
   `repository` methods' names against the list above.
2. If the names differ (near-certain — this is a documented guess), update
   the three guarded lookups in `probe()` and the corresponding calls in
   `actSearch`/`actBuy`/`actReadResult`. Nothing else in the codebase needs
   to change — that is the whole point of the never-forge-a-request seam.
3. Run a real search through the app's own UI with DevTools' Network tab
   open, capture one `transfermarket` response, and diff it against
   `test/fixtures/mock-ea-app/payloads.js`'s shape (`itemData.resourceId`,
   `buyNowPrice`, `expires` as seconds-remaining, etc.) — passive
   observation has been correct since milestone 1 and almost certainly still
   is, but this is the cheap way to be sure before trusting `act.search`'s
   result-shape guess (`extractAuctionInfo`'s `auctionInfo`/`items` fallback)
   too.
4. Call `services.Item.repository.search({})` directly in the console and
   compare its resolved shape against what `extractAuctionInfo` expects.
5. Only once 1–4 pass: flip a test account to a `ledger-auto`-entitled plan
   and watch one real, human-confirmed `assist.confirmBuy()` (M2, not M3) go
   through before trusting the automated loop at all.

## 5. Safety governor: thresholds and math

`engine/governor.ts`'s `Governor.allow(action)` is the single gate every
`adapter.act()` call passes through — `assist.ts` and `autobuyer.ts` both
call it before _every_ attempt, never once per session. Four thresholds,
all from `GovernorSettings` (`packages/shared/src/schemas/settings.ts`,
user-tunable within `GOVERNOR_ABSOLUTE_LIMITS`, the hard floor/ceiling
independent of any user or admin setting):

| Threshold              | Default | Absolute bounds | Kind          |
| ---------------------- | ------- | --------------- | ------------- |
| `actionsPerHour`       | 30      | 1–120           | **hard stop** |
| `sessionLengthMinutes` | 90      | 5–240           | **hard stop** |
| `buyToSearchRatio`     | 0.35    | 0.01–1          | soft deny     |
| `maxCoinFlowPerHour`   | 300,000 | 1,000–5,000,000 | soft deny     |

- **`actionsPerHour`** — sliding one-hour window over every action (search
  _and_ buy both count — a burst of very fast searching is itself a
  suspicious shape, not just buying). Checked against what the count
  _would become_ if the action were allowed, so the limit is never exceeded
  by even one action.
- **`sessionLengthMinutes`** — wall-clock time since the `Governor` instance
  was created. Crash recovery (§7) carries this across a page reload within
  the same browsing session rather than resetting it — resetting it on
  reload would be a governor bypass disguised as a convenience.
- **`buyToSearchRatio`** — `(buys + 1) / max(searches, 1)` must stay under
  the ratio for a `buy` to be allowed. A human who only ever buys and never
  searches is about the single most suspicious shape there is.
- **`maxCoinFlowPerHour`** — sliding one-hour window over coins spent on
  `buy` actions specifically (added to `GovernorSettings` for this file —
  see `packages/shared/src/schemas/settings.ts`, additive/backward-
  compatible).

`actionsPerHour` and `sessionLengthMinutes` are **hard stops**: exceeding
either puts the governor into a cooldown (`cooldownSeconds`, default 20,
bounds 0–3600) during which _every_ action — search or buy — is denied,
not just the one that tripped it, and a `risk_budget_events` row with
`kind: 'hard_stop'` is produced alongside the specific threshold's own kind.
`buyToSearchRatio` and `maxCoinFlowPerHour` are **soft denies**: only the one
action that would breach the threshold is denied — both are self-correcting
(searching more lowers the ratio; waiting drains the coin-flow window), so a
second cooldown on top would be redundant.

The **kill switch** (`Governor.setKillSwitch(active, reason)`, driven by
`lib/license.ts`'s bootstrap/heartbeat response's `killSwitchActive` field)
is checked first, always, and is unconditional — no threshold math runs
once it is active, regardless of build target.

`Governor.snapshot()` is the always-on "current utilization" read the risk
meter (`ui/panel.ts`'s "Risk budget" section, and the popup) displays; it
never denies anything itself, `allow()` is the only gate.

## 6. Telemetry — "What it sends"

This is the same list the options page's "What it sends" panel shows,
word for word (`options/main.ts`'s `WHAT_IT_SENDS`), and the same list
`docs/01-architecture.md` §3.3b/§5 frame as the telemetry trust boundary:

- **Activity**: login/logout, search _metadata_ (a hash of the filter +
  result count — never the listings themselves), filter changes, settings
  changes, errors, heartbeats.
- **Snipe attempts**: resource/trade id, target and listed price, outcome
  (including `blocked` — what proves the governor did its job), latency.
- **Trades**: buy/sell price and net profit, computed entirely client-side
  by `model/prices.ts`.
- **Filter stats**: realised coins/hour per saved filter, so the ranker's
  rotation/retirement survives a reinstall.
- **Risk-budget events**: what the governor allowed or blocked, and why.
- **Version/install telemetry and error reports**: extension version, a
  device fingerprint hash, message + stack (never user input, never a
  listing).

**`telemetryOptOut`** (`lib/telemetry.ts`) is checked client-side, before
anything is even queued for send — an opted-out user's data never leaves
the machine in the first place, it is not a server-side filter on data that
already arrived. It does **not** affect the license heartbeat
(`lib/license.ts`), which sends only an install id, the extension version,
and a device fingerprint hash — no product data at all — so a paying,
opted-out user's license still validates.

**Never sent, ever**: raw market listings (stay in `store/db.ts`'s
IndexedDB, local-only, no server-side observation table exists at all —
docs/01-architecture.md instruction 6), the EA session token, club data,
trade history from the game itself.

**Queue durability** (docs/12-testing.md "Defects found" #9): everything
above is queued in `lib/telemetry.ts` between `chrome.alarms` flush ticks
(every 2 minutes). The queue is persisted to `browser.storage.session`
(falling back to `.local` if `.session` throws) on every enqueue, not just
held in a bare module variable — an MV3 service worker killed for
inactivity between ticks used to lose everything queued since the last
flush; on the next wake, `flush()`/any enqueue call re-hydrates from
storage first, so a queued batch survives the restart. A best-effort extra
flush also fires on `chrome.runtime.onSuspend` (background/telemetry.ts) —
not the safety net (the persistence above is), just an earlier send
attempt when the browser signals it's about to unload the extension's
background context.

## 7. Crash recovery

`content/index.ts` persists `Governor.serialize()` (action timestamps, buy/
search counts, coin-flow entries, cooldown/kill-switch state) every 5
seconds and on `pagehide`, and reads it back before constructing the
governor on load; if present, it `Governor.hydrate()`s from it instead of
starting fresh. The store is background's `browser.storage.session`
(`background/governor.ts`, key `sl.engine.state.v1`), reached through the
`engine.stateSet` / `engine.stateGet` messages — **never called from the
content script directly**: MV3 content scripts are not a trusted context
for `storage.session` (Chrome's default access level is
`TRUSTED_CONTEXTS`), the call throws, and a thrown boot used to take M1
recording down with it (docs/12-testing.md "Defects found" row #10). The
access level is deliberately not widened, because `storage.session` also
holds the access token (§9). `storage.session` is still the right primitive
because it survives a page reload within the same browsing session but is
cleared when the browser closes — exactly matching "the risk budget should
survive an SPA reload" without also matching "the risk budget should
survive forever," which would make `sessionLengthMinutes` meaningless.

M1 recording never depends on any of this: the engine bindings are declared
before the adapter callbacks are registered, and a failed account-gated
M2/M3 bootstrap is logged, not allowed to abort the page's recorder.

The **watchdog** is a second `setInterval` that tracks the timestamp of the
last `probe` message received from the MAIN-world adapter; if none has
arrived in 60 seconds, it logs a warning (surfaced through the same
`lib/logger.ts` ring buffer the options page's log export reads). Because a
genuine full-page navigation re-injects both content scripts fresh (Chrome's
normal behaviour for `content_scripts`, not something this extension has to
implement), the watchdog's practical role is detecting an in-page SPA
navigation that orphaned the MAIN-world script without a real reload — the
state-hydration path above is what actually "recovers"; the watchdog is
what notices when recovery hasn't happened yet.

## 8. Auto-update

`background/update.ts` listens for `browser.runtime.onUpdateAvailable` and
calls `browser.runtime.reload()`. For `ledger` this only ever fires from a
Chrome Web Store update; for `ledger-auto` it fires from Chrome's own
periodic check of the manifest's `update_url` (self-hosted, per Web Store
policy for tools that automate gameplay — docs/01-architecture.md §6).

**Known, documented simplification**: the update is applied immediately
rather than first confirming with the content script that no buy is in
flight, so a mid-buy reload is possible today. The natural fix is gating on
`content/index.ts` reporting an idle engine state before
`background/update.ts` reloads — the cleanest channel for that is the WS
gateway's push (docs/01-architecture.md §3.7), which does not exist yet
(`apps/api` is built concurrently by another agent). Until then,
`content/index.ts`'s own crash recovery (§7) means a mid-update reload loses
at most the in-flight attempt's outcome reporting, not the risk budget
itself.

## 9. Error reporting

`lib/logger.ts` keeps a 500-entry ring buffer (`debug`/`info`/`warn`/
`error`); `warn`/`error` entries also echo to the console. `lib/errors.ts`
flushes only `warn`/`error` entries to `POST /extension/errors`
(`extensionErrorReportSchema`, `@sl/shared`) — `message`/`stack`/`context`
only, capped and truncated per the schema, never anything the user typed.
`background/index.ts` installs global `error`/`unhandledrejection` handlers
on the service worker itself, so a background crash is reportable too, and
runs a 5-minute `chrome.alarms` flush independent of the on-demand
`errors.report` message the options page's other flows can trigger.

The options page's "Export logs" button downloads the _background_ service
worker's ring buffer as JSON (`logs.export` message) — a documented,
current limitation is that `content/index.ts`'s own `logger` calls (e.g. the
watchdog's warning above) are not yet forwarded to background, so they are
not included in that export; only what background itself logs (auth/
license/telemetry/errors handler failures) is.

## 10. Settings sync conflict rules

**Server version wins, always.** `UserSettings.version`
(`packages/shared/src/schemas/settings.ts`) is bumped by `apps/api` on every
write. `lib/settings.ts` never applies a local edit optimistically — every
change is a `PATCH` sent to the server, and the cache
(`storage.local`) is only ever overwritten with whatever the server hands
back from that `PATCH` or the next `GET`. There is no merge step and no
"local wins if newer" fallback: if an admin lowers a governor bound between
two of this device's requests, the next read simply replaces the cache with
the lower bound, full stop. Offline, the cache is used as-is (last known
good) until the next successful read reconciles it — this is deliberate:
a lower admin-set ceiling must always eventually win over a stale local
value, and "always eventually" beats "sometimes never" for a safety
control.

## 11. Security notes

- **Token storage.** The access token lives in `storage.session` (cleared
  when the browser closes, never written to disk). The refresh token is
  AES-GCM-encrypted (`lib/storage.ts`) under a per-install key generated
  with WebCrypto and itself stored in `storage.local` — the refresh token
  is never written to any storage in plaintext.
- **CSP.** `content_security_policy.extension_pages`:
  `script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'`
  — no remote code, no plugins, no embedding.
- **Permissions.** `storage`, `unlimitedStorage` (months of market history
  is the point), `alarms`. `host_permissions` is exactly the two EA web-app
  origin patterns plus `${VITE_API_ORIGIN}/*` — nothing else, so the
  extension has no host permission that would let it talk to any third
  party.
- **The privacy seam.** `trimAuction` in `adapter.ts` is the only function
  that decides what leaves the page at all; the session token, club and
  trade history are never read by any part of this codebase, not "read but
  not sent" — never read.
- **No CAPTCHA bypass, no client impersonation.** Not present anywhere in
  this codebase, not planned. The act surface only ever drives the app's
  _own_ service-layer functions — the same ones its own UI calls — never a
  hand-built request, never a spoofed header, never the session token used
  outside a call the app's own code would have made.

## 12. Testing

```
pnpm --filter @sl/extension typecheck
pnpm --filter @sl/extension lint
pnpm --filter @sl/extension test          # vitest, jsdom + fake-indexeddb
pnpm --filter @sl/extension build:ledger
pnpm --filter @sl/extension build:auto
pnpm --filter @sl/extension test:e2e      # Playwright — see test/e2e/extension.spec.ts's header
```

`test:e2e` needs a headed Chromium context (MV3 unpacked-extension loading
does not work in classic headless mode); this repo's sandbox has no display,
so it runs `xvfb-run -a pnpm --filter @sl/extension test:e2e` instead —
confirmed passing that way against `/opt/pw-browsers/chromium` (both the
static "no autobuyer in `dist/ledger`" check and the full loaded-extension
check against the mock EA web app). On a machine with a real display, the
plain command above is enough on its own.

`test/model/prices.test.ts` ports milestone 1's 9 price-model tests
verbatim (same assertions, vitest syntax). `test/engine/ranker.test.ts` and
`test/engine/governor.test.ts` cover EV scoring, filter decay/retirement,
and every governor threshold (actions/hour sliding window and hard stop,
session length hard stop, buy/search ratio soft deny including the
divide-by-zero guard, coin flow soft deny and its own sliding window, kill
switch, cooldown, and `serialize`/`hydrate` round-tripping).
