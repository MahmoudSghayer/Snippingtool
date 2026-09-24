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
                          "What it sends", logs export, "Copy diagnostics" (§4), account/license info.
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
   `trimAuction` copies ever cross it (§11). Any page script can post on
   this channel too, so `act_request` and `action_result` each carry an
   HMAC under a per-page-load nonce that `content/handoff.ts` hands the
   adapter at `document_start` (`lib/act-auth.ts`); unsigned or replayed
   requests are ignored, and content schema-validates every inbound
   message and drops unsigned or unmatched results. A `buy` is refused
   (`price_mismatch` / `listing_unknown`) unless its price equals the
   buy-now price the adapter itself last saw for that `tradeId`.
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
| 1b   | `src/content/handoff.ts` (ISOLATED, `document_start`, before `adapter.js`)    | `lib` (IIFE, single entry) | `handoff.js`                                                      |
| 2    | `src/content/index.ts`                                                        | `lib` (IIFE, single entry) | `content.js`                                                      |
| 3    | `src/background/index.ts` + `src/popup/index.html` + `src/options/index.html` | ES, multi-entry            | `background.js`, `src/popup/index.html`, `src/options/index.html` |

`scripts/generate-manifest.mjs` then writes `manifest.json` from the two
targets' env (`VITE_API_ORIGIN`, `VITE_UPDATE_URL`, the package version).

**Licence key (required for a release build).** `VITE_LICENSE_PUBLIC_KEY`
must be the API's `ENTITLEMENT_PUBLIC_KEY`, pasted as-is (SPKI PEM; the
`\n`-escaped one-line form from `.env` works). `lib/license.ts` verifies
the cached entitlement blob with it. A build without it can verify nothing:
no offline grace, and every open EA tab polls `GET /extension/kill-switch`
every 8 s, where a rate-limit 429 reads as "kill switch active". So
`scripts/build.mjs` fails when the key is missing or is not an Ed25519
public key. Exceptions: `pnpm dev` (`--watch`) only warns, and
`SL_ALLOW_NO_LICENSE_KEY=1` allows a keyless build that will not ship (CI
checks and tests use it). The release workflow reads the key from the
repository variable `ENTITLEMENT_PUBLIC_KEY`.

The dashboard-download template (`pnpm --filter @sl/extension
build:template`, i.e. `ledger-auto --template`, built by the API image) is
exempt: it bakes in a placeholder that `apps/api/src/lib/extension-download.ts`
replaces, when it serves the zip, with the raw Ed25519 key from the API's own
`ENTITLEMENT_PUBLIC_KEY` (the JWK `x`, base64url). `lib/license.ts` imports
that form as well as PEM. A template whose placeholder was never filled in
verifies nothing and logs an error saying so, rather than throwing.

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

### The `userscript` target

`pnpm --filter @sl/extension build:userscript` builds the M1–M3 code (same
feature set as `ledger-auto`, `VITE_BUILD_TARGET=userscript`) into one
Tampermonkey file, `dist/userscript/nova-trade.user.js`, plus the
header-only `nova-trade.meta.js` Tampermonkey polls for updates.

Customers install it from the API, not from a static host: the chrome zip
stays the main install, and "My account" offers Tampermonkey as the
optional one-click alternative. `build:userscript-template` builds it once
with the zip's placeholder origins (`scripts/template-placeholders.mjs`)
plus a placeholder download token; the API image ships that file, and
`GET /api/v1/downloads/userscript/:token/nova-trade.user.js` (and
`.../nova-trade.meta.js`) fills in APP_ORIGIN, DASHBOARD_ORIGIN, the
license key and the token. The token is an HMAC of the user id (key derived
from COOKIE_SECRET, purpose `userscript-download:v1`), never stored;
Tampermonkey fetches without cookies, so the signed URL is what identifies
the user, and each request checks their pass (403 once it no longer
includes the autobuyer). `@version` is the extension version, and
`@downloadURL`/`@updateURL` are the same signed URLs, so updates follow
extension releases. `GET /api/v1/downloads/userscript/link` gives the
signed-in user their `installUrl`. No
extension code forks for it; `src/userscript/` supplies what the manifest
and the browser would otherwise provide:

| Extension                         | Userscript                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter.js` in the MAIN world    | The same adapter IIFE, built first and embedded as a string (`virtual:adapter-source`), injected with `GM_addElement` at `document-start` (`setup.ts`)                                  |
| Service worker + ISOLATED content | `background/index.ts` and `content/index.ts`, imported in that order by `main.ts` and run in Tampermonkey's isolated context                                                            |
| `webextension-polyfill`           | `browser-shim.ts` (build alias): one in-page message bus with Chrome's first-answer-wins rule and structured cloning; `storage.*` on `GM_*Value`; `alarms` on timers; `tabs` = this tab |
| `host_permissions` for the API    | `lib/http.ts`'s transport swapped for `gm-fetch.ts` (`GM_xmlhttpRequest`, `anonymous: true` so EA's cookies never go along); the API host is the header's only `@connect`               |
| Toolbar popup, options page       | `launcher.ts`: a button on the EA page opening a drawer that mounts `popup/app.ts` and `options/app.ts` in their own shadow roots; also in Tampermonkey's menu                          |

Differences that follow from there being no extension process:

- **`storage.session` persists.** It is GM storage under a `session:` prefix,
  so the access token and saved governor state survive a browser restart. A
  stale token is refreshed on its first 401, and resuming governor counters
  is the conservative direction.
- **Everything runs per tab.** Each EA tab has its own "background": its own
  alarms, heartbeat and kill-switch listener. Alarms only tick while an EA
  tab is open.
- **IndexedDB is ea.com's.** The observation database lives in the EA
  origin, so clearing ea.com's site data clears it, and EA's page code could
  read it. It only ever holds trimmed market listings; tokens and settings
  are in GM storage, which the page cannot reach.
- **No minification.** People install userscripts by hand and should be able
  to read what they are installing.
- **The page channel is authenticated the same way.** `setup.ts` mints the
  act-channel nonce and puts it on `<html>` before injecting the adapter,
  which takes it synchronously, as `handoff.js` does in the extension
  (`lib/act-auth.ts`'s `handOffNonceWithinBundle`; content's copy stays in
  the bundle, not on Tampermonkey's global). Content talks to the page
  through `unsafeWindow`, so the userscript's adapter (only) accepts act
  requests by origin rather than by `event.source`; every request, result
  and catalog is still MAC-checked.

### The Sniping Bot page (automation builds)

`ledger-auto` and `userscript` add a **Sniping Bot** page: an item under
Transfers in EA's left navigation (`ui/ea-nav.ts`) opens a full page
(`ui/bot-page.ts`) with the bot's settings on the left and the live session on
the right. The in-page panel and the userscript's SL menu open it too.

The bot (`engine/sniper.ts`) searches the user's saved filters in turn, buys
every listing at or under the price cap (cheapest first), then waits a random
delay from the user's range, with breaks every N searches and rests every N
minutes. It ships through the same `virtual:autobuyer-loader` alias as the
autobuyer (`loadSniper()`), so the `ledger` build never contains it, and the
autobuyer does not buy while the bot runs.

**Recommended limits, editable, with a live risk level.** The settings
(`BotSettings` in `@sl/shared`) live in `storage.local`, never on the
server. They start on the recommended limits (`RECOMMENDED_BOT_SETTINGS`):
a random 8–12 s search delay, at most 250 searches and 15 buys an hour, a
60-minute session then a 20-minute rest, at most 6 active hours a day, at
most 500,000 coins spent an hour, and a 10 s cooldown after every buy. The
user can change any of them within `BOT_LIMITS` (the hard technical
bounds); "Reset to recommended" restores them. Settings saved by older
builds still parse: missing fields take the recommended values, and the
retired `safetyMode`, `customRiskAcknowledgedAt`, `safety.actionsPerHour`
and `safety.sessionLengthMinutes` are accepted and ignored.

`botRiskLevel(settings)` rates them live: searches a day
(min(max searches an hour, 3600 / shortest delay) × active hours a day,
where active hours are the session/rest duty cycle over 24 h, capped by max
active hours a day), buys a day (max buys an hour × the same hours), and the
shortest delay. Tiers, the worst factor winning: low up to 2,000 searches /
100 buys a day with at least 6 s between searches; moderate up to 3,500 /
150 / 4 s; high up to 5,000 / 250 / 2 s; very high beyond. The recommended
defaults rate low (1,500 searches, 90 buys a day). The page shows the level,
the projections and the reasons, and says the thresholds come from limits
traders have reported, not from EA. The first time the user saves settings
above low, the page holds them back until they tick "I understand these
settings raise the risk of an EA ban, and that a ban is never refundable";
`riskAcknowledgedAt` records when, and the engine will not start settings
above low without it. Each save that changes the level is reported as a
`settings_change` activity event with the field `bot.riskLevel=<level>`
(`lib/bot-safety.ts`), subject to the usual telemetry opt-out.

The engine (`engine/sniper.ts`) enforces the user's own numbers, clamped
into `BOT_LIMITS` first (`clampBotSettings`): searches and buys an hour on
sliding windows, the session/rest cycle, active hours a day (per local day,
saved through `bot.usageGet` / `bot.usageSet` so a reload doesn't reset
it), the cooldown after each buy, and coins an hour and the buy:search
ratio through its own governor (`botGovernorSettings`, bounded by
`BOT_GOVERNOR_BOUNDS`). The server kill switch and adapter probe failures
stop it whatever the settings say.

**Snipe targets are built like EA's own search panel**: OVR range slider
with Min/Max OVR, "Type Player Name" (with EA portraits), and Quality,
Rarity, Position, Chemistry Style, Country/Region, League and Club rows.
The lists are the web app's own: `main/adapter.ts` calls its
`UTDataProviderFactory` (`getRareItemLevelDP`, `getItemRarityDP`,
`getPlayerPositionDP`, `getPlayStyleDP`, `getNationDP`, `getLeagueDP`,
`getTeamDP` per league) and takes every picture from its
`AssetLocationUtils.getFilterImage`, so entries, order, labels and images
match EA's panel, in the user's web-app language. Like EA's panel, Club is
disabled until a league is chosen, and choosing a quality clears the rarity
and narrows the rarity list. Players come from the web app's `players.json`
(`AssetLocationUtils.getPlayerSearchFileUri()`). Stored in `storage.local`
(`catalog.get` / `catalog.save`, `model/catalog.ts`).

### Web app shape (verified 2026-09-23)

`main/adapter.ts` was checked against the FC 27 web app's own code
(`js/compiled_1-4.js`, `ocompiled.js`) and public data files:

| What       | The web app's own                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search     | `services.Item.clearTransferMarketCache()` then `services.Item.searchTransferMarket(new UTSearchCriteriaDTO(), page)` -> observable; `res.data.items`                                                |
| Buy now    | `services.Item.bid(item, auction.buyNowPrice)`                                                                                                                                                       |
| Criteria   | `type` (set first), `maskedDefId`, `level` (`bronze`/`silver`/`gold`/`SP`), `rarities`, `position` / `zone` (130-132), `playStyle`, `nation`, `league`, `club`, `minBuy`/`maxBuy`, `ovrMin`/`ovrMax` |
| Items      | `definitionId`, `databaseId` (base player id), `rating`, `getAuctionData()` -> `tradeId`, `buyNowPrice`, `expires`                                                                                   |
| Navigation | `.ut-tab-bar-item` buttons, Transfers has `icon-transfer`; top bar `.ut-navigation-bar-view`                                                                                                         |

The adapter waits for the web app to start (and log in) before its first
probe, and builds the catalog then.

Not yet available: transfer list, sold and unsold counts (the adapter has no
transfer list access yet).

## 4. The ASSUMED SHAPE and the day-one verification checklist

The live EA FC web app is unreachable while the market is locked, so
`main/adapter.ts`'s act surface (`search`/`buy`/`readResult`, M2/M3 only —
passive observation is unaffected and unchanged from milestone 1) is written
against **documented assumptions**, not observed fact. Rather than one guess,
the adapter carries two candidate shapes, each in its own module under
`src/main/` (`main/shapes.ts` lists them), and the probe selects whichever
the page has:

- **observable** (`main/shape-observable.ts`, tried first — what community
  autobuyers describe):
  `services.Item.searchTransferMarket(criteria, 1)` and
  `services.Item.bid(item, price)`, each answering once through
  `.observe(scope, (sender, response) => …)` with
  `{ success, data: { items } }`; items are entities with
  `getAuctionData()` or `_auction`, card id under `definitionId`,
  `resourceId` or `maskedDefId`.
- **promise** (`main/shape-promise.ts`, the original assumption):
  `services.Item.repository.search(criteria) -> Promise<{ auctionInfo }>`,
  `services.Transfer.repository.buyNow(tradeId)`, and
  `services.Transfer.repository.bid` probed for presence only.

Neither present: `probe()` fails closed with a `reason` naming what each
candidate was missing, and act is disabled. Every lookup is guarded, so a
renamed property is a clean probe failure, never a thrown exception.
`probe()` runs once at load and again before every act call, so a bundle
update mid-session is caught immediately (docs/01-architecture.md §3.5).

**No silent success.** Whatever a service call returns goes through
`main/ea-response.ts` (an observable is observed, a promise awaited, both
with a 12 s limit) and `main/ea-listing.ts` (entities and UTAS JSON
normalised field by field). A search whose response has no list, reports
`success` other than `true`, or holds only unreadable entries is an error —
never `ok` with no listings. An empty list is still a real "no results".

Shape-specific limits, all to confirm on day one:

- The observable shape's search criteria use the community-known
  `UTSearchCriteriaDTO` field names, none verified: `type: 'player'`,
  `resourceId` → `maskedDefId`, `minPrice`/`maxPrice` → `minBuy`/`maxBuy`,
  `position` → `position`, `nationality` → `nation`, `league` → `league`,
  `club` → `club`, `quality` → `level` (`bronze`/`silver`/`gold`, and
  `special` → `SP`). Rating has no known DTO field: `minRating`/`maxRating`
  are a pure guess. Any other field is refused (`cannot search by …`)
  rather than searched wider. It builds the page's own
  `UTSearchCriteriaDTO` when one exists.
- The observable shape buys on the item entity. It gets entities from its
  own searches and, through a hook on `services.Item.searchTransferMarket`
  (`main/search-hook.ts`), from searches the human runs in EA's UI: the
  hook calls the original, adds one observer of its own, and hands the
  page the original observable untouched. The hook reports no search of
  its own (passive observation reports it, once, from the network): it
  only keeps the entities and, if passive already reported those listings,
  sends a `listings_buyable` upgrade that content applies without counting
  anything. Likewise an act search and its own network response are one
  search: a market request sent while an act search is in flight is tagged
  as that search's, and the act result and that tagged response (same
  tradeIds, in either order) are posted once. Nothing else is ever merged:
  two human searches with the same, often empty, results are two searches,
  and each counts toward `actionsPerHour`. A listing seen only passively
  (no entity) is sent to content with `buyable: false`, the ranker drops
  it, and it is never attempted; asked anyway, the adapter refuses with
  `listing_entity_unknown`. The entity's price is re-checked too, on top of
  the Task 2 price check. A search response must carry `success: true`.
- A buy EA has not answered within 12 s is reported as `timeout_unknown`,
  not as a failure: it may have gone through. It is recorded as
  `attempted`, stays charged to the governor, is never retried, and if
  EA's answer arrives later the adapter sends a second, signed `late`
  result that records the trade. An adapter *refusal* (price mismatch,
  unknown listing, no entity, no act key) never reached EA, so the
  governor refunds what it charged for it.
- The card id is `resourceId`, `definitionId` or `maskedDefId`, never
  `assetId` (the base player, shared by every version of a card).
- The observable shape has no verified trade-status call, so `readResult`
  fails loud. (Nothing calls `readResult` today.)
- The promise shape treats a resolved `buyNow` as success unless it says
  `success: false`; the observable shape needs an explicit `success: true`.

**Day-one checklist**, once the market unlocks and the real web app is
reachable:

1. Load the extension, sign in, and open the real FC web app. Go to the
   transfer market and run one search by hand in EA's own UI.
2. Open the extension's options page (right-click the toolbar icon →
   Options) and click **Copy diagnostics** under *Diagnostics*. It asks the
   open EA tab's adapter for its report over the authenticated act channel
   and copies a JSON report (also shown below the button). Paste it into
   the team channel. It carries key names and types, never values: no
   tokens, emails or coin balances.
3. Read `adapter.probe` and `adapter.candidates`:
   - **Good, observable shape:** `probe.ok: true`, `probe.shape:
     "observable"`; `servicesKeys.Item` lists `searchTransferMarket` and
     `bid` as `"function"`; `globals.UTSearchCriteriaDTO` is `"function"`;
     `globals.searchHook` is `"installed"`, and the log has `search hook
     installed`; after the human's own search the log shows no `hook:`
     errors and `lastMarketResponse.source` is `"hook:search"`;
     `lastMarketResponse.shape` (after an act search) has `success:
     "boolean"` and `data.items["[0]"]` with `getAuctionData: "function"`
     or an `_auction` object, plus one of
     `definitionId`/`resourceId`/`maskedDefId`.
   - **Good, promise shape:** `probe.ok: true`, `probe.shape: "promise"`;
     `servicesKeys.Item.repository.search` and
     `servicesKeys.Transfer.repository.buyNow` are `"function"`.
   - **Neither:** `probe.ok: false`, and `candidates` says what each shape
     was missing. `servicesKeys` shows what `window.services` really has,
     three levels deep — write (or fix) a shape module from it. Nothing
     outside `src/main/` needs to change: that is the never-forge-a-request
     seam.
4. Check the passive side in the same report: `lastMarketResponse.source:
   "passive"` with `shape.auctionInfo["[0]"]` holding `tradeId`,
   `buyNowPrice`, `expires` and `itemData.resourceId` as numbers, and
   `stats.failed` at 0. Diff it against
   `test/fixtures/mock-ea-app/payloads.js` if anything differs.
5. With a saved filter that sets only a max price, let assist run one
   search, then **Copy diagnostics** again: the last `log` lines should read
   `search ok (<shape>): N listings`, and `lastMarketResponse.source` should
   be `"act:search"`. `search failed: …` there, or `N` at 0 when EA's own UI
   shows results for the same filter, means the criteria field names are
   wrong: fix the shape's criteria builder. Repeat with a filter for each
   of position, nation, league, club and quality, and compare against the
   same search in EA's UI (the `level`/`SP` and rating names are the
   likeliest to be wrong). `skipped N unreadable entries` in the log means
   part of the item shape changed.
6. Check that the card id lines up: the `resourceId` the panel shows for a
   listing must be the same number EA's UI uses for that exact card
   version (not the base player's `assetId`).
7. Only once 1–6 pass: flip a test account to a `ledger-auto`-entitled plan
   and watch one real, human-confirmed `assist.confirmBuy()` (M2, not M3) go
   through (`buy ok (<shape>)` in the log) before trusting the automated
   loop at all. Confirm what a *failed* buy looks like too (outbid or
   expired listing): it must show as `buy failed`, never `buy ok`. Note
   how long a real `bid` takes to answer: a `timeout_unknown` in the log
   means EA took over 12 s, and a following `late buy answer` line says
   how it went. Several of those mean the limit is too short.
8. **Trade pile (profit capture, lib/trade-lifecycle.ts).** All assumed:
   - The paths `/ut/game/<title>/tradepile` (a missing list there is a
     shape change), `/item` and `/auctionhouse/relist` (only logged).
     `/watchlist` and `/trade/status` are deliberately not read: they show
     auctions the trader won or bought as `closed` at the price paid, which
     is a purchase, and was once misread as a sale.
   - The envelope `auctionInfo` (or `itemData`); the item id at
     `itemData.id` (an entity's `id`), and the same id on a market
     listing's `itemData`.
   - `tradeState` of `active`, `closed` (sold) or `expired`, null or absent
     when unlisted, with `tradeId` 0. A sold listing's price is its
     `currentBid` (falling back to `buyNowPrice`). A `closed` item counts
     as a sale only for the listing the lifecycle saw listed, never on the
     tradeId the card was bought on.
   - A plain GET of `/tradepile` is the whole transfer list: a listed or
     expired card missing from it is marked gone (no longer listed value).
   - `soldAt` is when the sale was *seen* on the pile, not when it
     happened (EA gives no sale time), clamped to be no earlier than the
     purchase.

   To check: open the transfer list in EA's UI, then **Copy diagnostics**
   and read `lastTradePileResponse` (path, keys and types) and `lifecycle`
   (`buysWithoutItemId` above 0 means market listings carry no item id).
   Then list a card an engine bought, let it sell, reopen the transfer
   list, and confirm the dashboard shows that trade `sold` at the right
   price. `trade pile:` lines in the log mean one of the above is wrong. A
   card bought outside the extension is never followed (no buy price to
   close it with).

## 5. Safety governor: thresholds and math

`engine/governor.ts`'s `Governor.allow(action)` is the single gate every
`adapter.act()` call passes through — `assist.ts` and `autobuyer.ts` both
call it before _every_ attempt, never once per session. Four thresholds,
all from `GovernorSettings` (`packages/shared/src/schemas/settings.ts`,
user-tunable within `GOVERNOR_ABSOLUTE_LIMITS`, the hard floor/ceiling
independent of any user or admin setting). The governor clamps whatever
settings it is given (constructor and `setSettings`) into those bounds, so a
stale cache or a hand-edited value can never loosen it; a non-finite value
falls back to the shipped default:

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
- **`sessionLengthMinutes`** — wall-clock time since the session started.
  Crash recovery (§7) carries this across a page reload within the same
  browsing session rather than resetting it — resetting it on reload would
  be a governor bypass disguised as a convenience. Once it trips and its
  cooldown has elapsed, the next `allow()` starts a new session: the session
  clock and the per-session buy/search counts reset, while the cooldown, the
  one-hour windows and the kill switch do not. `resetSession()` does the
  same on demand (for a future UI button).
- **`buyToSearchRatio`** — `(buys + 1) / max(searches, 1)` must stay under
  the ratio for a `buy` to be allowed. A human who only ever buys and never
  searches is about the single most suspicious shape there is. Searches are
  counted two ways (`engine/search.ts`): every search the extension issues
  goes through `governedSearch`, which calls `allow({ kind: 'search' })`
  first and skips the search if denied; a search the human runs in EA's own
  UI is only observed, so `recordObservedSearch()` counts it (toward this
  ratio and `actionsPerHour`) without gating. The adapter reports one search
  response more than once, so observed reports within 1.5 s of the last
  counted search, or while an engine search is in flight, count as that
  same search.
- **`maxCoinFlowPerHour`** — sliding one-hour window over coins spent on
  `buy` actions specifically (added to `GovernorSettings` for this file —
  see `packages/shared/src/schemas/settings.ts`, additive/backward-
  compatible).

An allowed buy the adapter then *refuses* before calling EA (price
mismatch, unknown listing, no entity, no act key), in a result whose MAC
verified, is refunded with `Governor.refund(decision)`. An unsigned outcome
is never refunded, even one reading `adapter_unauthenticated` (content's own
timeout after an unsigned probe hint, which a page script can forge): it never reached EA, so it must not use up the
action, buy or coin budget. A buy EA saw, or may have seen
(`timeout_unknown`), stays charged.

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

It also has to reach an engine that is **already running**, not just the
next page load. Two paths, both in the extension (the extension has no
WebSocket client; the API's `kill_switch` WS event fans out to the admin
overview only):

- **Push** — `background/kill-switch.ts`: after every bootstrap and every
  heartbeat (the 10-minute `chrome.alarms` tick, or a forced one from the
  popup), `propagateKillSwitch()` sends `engine.killSwitch` (strict schema
  `extContentKillSwitchMessageSchema` in `@sl/shared`) to every open EA tab
  via `tabs.query({ url: EA_WEB_APP_MATCHES })` + `tabs.sendMessage`. No
  new manifest permission: a URL-filtered query needs only the EA host
  permissions the manifest already declares. An active switch is
  re-broadcast on every heartbeat (cheap, and closes the "tab opened
  between two heartbeats" gap); a deactivation is broadcast once. The last
  pushed value lives in `storage.session` so a restarted service worker
  does not re-announce a deactivation.
- **Pull** — `content/index.ts`'s engine tick (every 8 s) asks background
  for `license.killSwitchGet`, the flag signed into the cached entitlement
  blob (no network), and applies any difference. A missed push is therefore
  corrected within one tick. The cached `killSwitchActive` field is never
  read (anyone can edit `storage.local`); with no signed flag (cache
  missing, tampered or expired, or a blob signed before the flag was a
  claim) background asks `GET /extension/kill-switch`, and reports the
  switch active if that fails too.

Either path calls the content script's `applyKillSwitch()`, which sets the
governor's switch, updates the in-page panel's status line ("Kill switch
active — all actions blocked.") and, while active, short-circuits the
engine tick entirely. The flag is tracked in the content script as well as
in the governor so the panel reports it even on an account with no engine
(M1-only) and so a push that arrives before the M2 bootstrap finishes is
not lost. Worst-case latency from an admin flipping the toggle to an open
tab halting is therefore one heartbeat period (10 min) plus one engine
tick; the cross-app e2e journey (b) asserts the open EA tab reports the
switch after the heartbeat with no reload.

**Known limit — features in an open tab.** Features (`assist.ranker`,
`automation.autobuyer`) are read once, from `license.bootstrap` at page
load; there is no features push. So when the 24h offline grace runs out, an
EA tab that is already open keeps its features until it reloads (every new
`license.bootstrap` answer has them off). The kill switch is not affected:
it still reaches that tab by push and pull as above.

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
anything is even queued (`enqueue()` queues nothing while opted out or
signed out) and again at flush — an opted-out user's data never leaves
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

**Retries** (P0 task 11): each batch type flushes independently, and only
the chunks that failed are re-queued. Every sniping attempt carries a
client `attemptId` (kept with its original `occurredAt` in the queue), so a
re-sent attempt is stored once by the API. A batch rejected with a 4xx
other than 401/403/408/429 is logged and dropped, not retried forever,
except a `TIMESTAMP_OUT_OF_WINDOW` 400: it names the offending items
(`details.indices`), only those are dropped, and the rest of the chunk is
sent again at once. Items outside the API's timestamp window (5 minutes
ahead; 7 days back for activity and sniping, 400 days back for trades) are
dropped before sending; each batch type holds at most 1,000 items, oldest
dropped first.

**Clock skew.** The API keeps that window strict and never clamps (a
clamped `occurredAt` would stop matching a retried attempt's idempotency
key). Instead `lib/clock.ts` keeps the offset between this machine and the
server, measured from the `serverTime` in every bootstrap and heartbeat
response and persisted in `storage.local`. `lib/telemetry.ts` moves an
item's `occurredAt`/`boughtAt`/`soldAt` onto the server's clock once, when
the item is queued, so the persisted item — and every retry of it — carries
the corrected timestamp, and a machine whose clock runs fast loses
nothing. The before-sending filter uses the corrected clock too.

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
