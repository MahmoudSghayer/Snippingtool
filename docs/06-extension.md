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
    engine-lease.ts         This tab's side of the one-engine-per-profile lease (§7).
    live-settings.ts         Applies settings changes from storage.onChanged, no reload.
    assist-keys.ts            The assist chords' page listener + confirm-overlay text.
  engine/
    ranker.ts              Opportunity scoring (EV per listing of the current search).
    governor.ts             Safety budget — every act() call goes through allow().
    assist.ts                M2: Alt-chord selection + confirm-overlay buy, filter cycling.
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
   buy-now price the adapter itself last saw for that `tradeId`. Automation
   builds add `list`, `pile`, Nova AI's Bid mode acts (`bid`, `watchlist`,
   `move`) and Gallery mode's `club` and `owned` ("The Sniping Bot page"
   below): a `bid` is refused unless it is exactly the next valid bid on the
   auction as the adapter last saw it, the watch list and the club read come
   back only inside the signed `action_result`, and `move`, `club` and
   `list` act only on a card the adapter itself bought or won on this page
   load.
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

|                       | `ledger`                               | `ledger-auto`              |
| --------------------- | -------------------------------------- | -------------------------- |
| Contains              | M1 recorder + M2 assist                | M1 + M2 + M3 automation    |
| `name`                | "Nova Trade"                           | "Nova Trade"               |
| `VITE_AUTOMATION`     | `'0'`                                  | `'1'`                      |
| `update_url`          | absent (Chrome Web Store owns updates) | set from `VITE_UPDATE_URL` |
| `version_name`        | absent                                 | `"<version>-auto"`         |
| `engine/autobuyer.ts` | **never in the module graph at all**   | included                   |

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
includes the autobuyer). `@downloadURL`/`@updateURL` are the same signed
URLs. The image's copy has the extension version as its `@version`; in
production every userscript publish installs a fresh template, with that
publish's stamped `@version`, in a directory the API reads first
(`USERSCRIPT_TEMPLATE_DIR`) and serves from the next request on, so installs
from the dashboard update on every publish (`docs/11-devops.md` §4a).
`GET /api/v1/downloads/userscript/link` gives the
signed-in user their `installUrl`. No
extension code forks for it; `src/userscript/` supplies what the manifest
and the browser would otherwise provide:

| Extension                         | Userscript                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter.js` in the MAIN world    | The same adapter IIFE, built first, obfuscated, and embedded as a string (`virtual:adapter-source`), injected with `GM_addElement` at `document-start` (`setup.ts`)                     |
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
  tab is open. The engine lease (§7) lives in the shared GM store, so with
  one tab it is always free; two userscript tabs share it too, up to a
  near-simultaneous pair of acquires (each acquire reads back what it wrote).
  `storage.onChanged` reports only this tab's own writes.
- **IndexedDB is ea.com's.** The observation database lives in the EA
  origin, so clearing ea.com's site data clears it, and EA's page code could
  read it. It only ever holds trimmed market listings; tokens and settings
  are in GM storage, which the page cannot reach.
- **Obfuscated.** A userscript is installed by hand, so unlike the extension
  (which ships through a store or the update server) its whole source sits in
  the user's script manager in the clear. The owner distributes it per
  licensed user and does not want it read or copied wholesale, so the
  published file is obfuscated (see "Obfuscation" below). The extension
  builds (`ledger`, `ledger-auto`) are never obfuscated.
- **The page channel is authenticated the same way.** `setup.ts` mints the
  act-channel nonce and puts it on `<html>` before injecting the adapter,
  which takes it synchronously, as `handoff.js` does in the extension
  (`lib/act-auth.ts`'s `handOffNonceWithinBundle`; content's copy stays in
  the bundle, not on Tampermonkey's global). When Tampermonkey injects
  after page scripts have started, it still hands off, and content logs
  once per page load that it was late. Nothing else breaks: the adapter
  re-reports its probe as soon as the web app's service layer turns up
  (and content does not report a failing probe from before the web app
  started); only market calls made before the injection go unseen. Content talks to the page
  through `unsafeWindow`, so the userscript's adapter (only) accepts act
  requests by origin rather than by `event.source`; every request, result
  and catalog is still MAC-checked.

#### Obfuscation

Only the userscript is obfuscated, and only its code — never the extension
builds, never the `==UserScript==` header or the `.meta.js` file.
`scripts/obfuscate.mjs` (javascript-obfuscator) runs inside `buildUserscript`
for the normal and `--template` builds alike. It is deliberately light:
identifier renaming (hexadecimal names) plus string hiding (string array,
base64, ~0.75 threshold), and **none** of the transforms that would cost the
trading hot path or risk EA's page — no control-flow flattening, dead-code
injection, debug protection, self-defending or global renaming. It raises the
published file by roughly 15% (about 0.9 MB → 1.05 MB). No source map is
produced or shipped.

Two things have to survive obfuscation untouched, and the build enforces both:

- **The four template placeholders** (`scripts/template-placeholders.mjs`):
  the API fills these in with a plain string replace at download time
  (`apps/api/src/lib/extension-download.ts`), so they must appear byte for
  byte in the output. They are passed as `reservedStrings`, which keeps any
  matching literal from being renamed, moved into the string array or
  encoded.
- **The embedded adapter.** The adapter is obfuscated on its own first (with
  lighter options — string-array indirection without base64, so no decode
  wrapper is added around code that runs in EA's page and relies on built-in
  references it captures at `document_start`). The main bundle is then built
  with a sentinel string in the adapter's place and obfuscated, and the
  sentinel is swapped for the already-obfuscated adapter afterward
  (`injectAdapterSource`). That is what stops the adapter's own string array
  being base64-encoded a second time inside the main bundle's.

`test/unit/userscript-obfuscation.test.ts` pins all of this: the code is
obfuscated, the header and `.meta.js` stay plain, the placeholders survive,
the sentinel is gone from the shipped file, obfuscated code still runs, and
the `ledger` build is not obfuscated.

### Assist hotkeys (P0 Task 13)

Modifier chords only (`lib/hotkeys.ts`, fixed defaults
`DEFAULT_ASSIST_HOTKEYS`): **Alt+Up/Down** move a selection through the
ranked listings of the _current_ search (never one from an earlier search),
**Alt+B** shows a confirm overlay naming the card (name and rating from the
item data, else `#resourceId`), its price and the expected profit after tax,
and a second **Alt+B** or a click on Confirm buys exactly that listing;
**Escape** cancels, and the overlay expires after 15 s. Alt+N / Alt+Shift+N
cycle the active saved filters, Alt+P pauses. Chords match
`KeyboardEvent.code`, so Option+B on a Mac works. EA's own keys (Enter,
Space, the arrows, Escape) are never `preventDefault`ed and always reach
EA; a key repeat never confirms; the listener and the overlay's buttons take
trusted events only, and the overlay is a closed shadow root, so a page
script can neither open nor confirm a buy.

### The Sniping Bot page (automation builds)

`ledger-auto` and `userscript` add a **Sniping Bot** page: an item under
Transfers in EA's left navigation (`ui/ea-nav.ts`) opens a full page
(`ui/bot-page.ts`) with the bot's settings on the left and the live session on
the right. The in-page panel and the userscript's SL menu open it too.

The page header shows the trader's coins and FC Points, read once a second
from EA's own top bar (`ui/ea-wallet.ts`: `.view-navbar-currency-coins` /
`-points`, an assumed shape like the navigation's), since the page can sit
over that bar. EA does not always redraw that bar after the bot's own buys
and sales, so the coins prefer the balance EA's own answers state: the
adapter reads `credits` from every market, trade-pile and buy (`/trade/<id>/
bid`) response it sees and sends it, when it changes, as a signed `credits`
message (automation builds only; never leaves the page). EA's bar wins again
once it changes after that balance arrived (a pack bought by hand, say).
Under the search, **Recent searches** lists the last 10
searches the bot was started on, newest first; clicking one fills the search
in again. It is a log, not saved filters, and it belongs to the account:
`GET`/`PUT /extension/recent-searches` keep it per user, through background
(`recentSearches.get` / `recentSearches.set`), so every browser the trader
signs in on shows the same list (`content/recent-searches.ts`). The page
reads it each time it opens; a start saves the list to extension storage
(`sl.bot.recentSearches.v1`, Tampermonkey's storage in the userscript build)
at once and to the account a moment later (debounced, never blocking the
bot). The account's list wins whenever it can be read, and replaces the local
copy; signed out or offline, the page shows the local copy. The first time a
browser reaches an account with an empty list, it uploads the list it kept
before sync existed, once (`sl.bot.recentSearches.migrated.v1`).

The bot's **settings** (search delay, breaks, rest, thresholds, auto-sell,
safety limits) follow the account the same way, inside background's own
`bot.settingsGet` / `bot.settingsSet` (`background/bot.ts`,
`GET`/`PUT /extension/bot-settings`), so a browser the trader signs in on
(another PC, a cloud machine) starts with the settings they chose. A save
goes to extension storage (`sl.bot.settings.v1`) at once and to the account
1.5 s after the last one in a burst; until that upload lands, a pending mark
(`sl.bot.settings.pending.v1`) makes the next load send the local copy up
instead of taking the account's older one (a save made offline is never
lost). Otherwise the account's settings win whenever they can be read and
replace the local copy; an account that has none gets this browser's; an
account that cannot be asked (signed out, offline, refused) leaves the local
copy in use and is never overwritten from it. The bot's hourly budgets and
daily usage stay per browser.

**Gallery mode's list follows the account** too (`background/bot.ts`,
`GET`/`PUT /extension/gallery`, `user_gallery`): its cards and their
progress, the fut.gg Sets on it, the Sets marked completed and when, and the
budget, so a browser the trader signs in on (another PC, a cloud machine,
the same one after signing out and back in) shows which Sets are done and
which are not. A save goes to extension storage (`sl.bot.gallery.v1`) at
once; a running bot saves after every card step, so the upload is throttled
rather than debounced: at most one every 2 s, always the latest list, so
steady saves never hold it back, and uploads go one after another (a list
with a newer one queued behind it is not sent), so an older list never lands
after a newer one. The PUT answers only `updatedAt`
(`putGalleryResponseSchema`), which is kept (`sl.bot.gallery.base.v1`) as
the account version this browser's copy is based on. At load:

- the account cannot be asked (signed out, offline, refused): the local copy
  stays in use and the account is never overwritten from it;
- a save that has not reached the account yet (pending mark
  `sl.bot.gallery.pending.v1`: made offline, or the browser closed within
  the 2 s) goes up first, while the account still holds the version this
  browser last saw (or none); if another browser has saved since, the
  account's list wins and this browser's completed Sets are added to it
  (and uploaded), so none is lost;
- the first sync of each browser (`sl.bot.gallery.synced.v1` unset), for
  lists kept before sync existed: the account's list, with the Sets this
  browser marked completed that it lacks added (with their times; past 500
  completed, the ones completed longest ago go), uploaded when that added
  any; an account with none gets this browser's list. The flag is set only
  once that has landed (or there was nothing to add, or a pending save
  landed, which carries this browser's completed Sets), so an account that
  could not be reached, or an upload that failed, leaves it to do at the
  next load;
- otherwise the account's list wins as it is and replaces the local copy:
  a Set undone (**Undo**) in another browser stays undone.

The content script reads the list at page load and again when the bot is
first prepared after the trader signs in from the account view, so that
sign-in shows the account's list without a reload. The API holds the list to
`galleryStateSchema` (a field added there needs the API deployed first: until
then the upload is refused and the local copy, still pending, stays in use).

The dash's **Sold** and **Unsold** counters and its **Transfer list** panel
(cards on the list out of EA's 100, then how many are listed and not
listed) are counted from the trade-pile responses EA's own page already
fetched, the same ones the trade lifecycle reads (section 4, item 8).
Content keeps the last full `/tradepile` GET and applies each partial
response (relist, item move) on top of it (`lib/transfer-list.ts`). EA's
page only loads that list when its Transfer List opens, which it does not
while Nova AI's page covers it, so the web app is asked to reload it
(`lib/pile-refresh.ts`, the adapter's `pile` act): about 2 s after each card
the bot lists, and every 3 minutes while the bot runs or the page is open
(at once on a start or an open when the last reload is older), never more
than once in 30 s; the adapter itself refuses one within 15 s
(`pile_too_soon`). The reload's answer only says EA answered: the list
reaches the counts through passive observation like any other load (and the
trade lifecycle sees each sale the same way). Until a whole list has been
seen they show "—" and ask the user to open it in EA. The page checks for
new figures on every refresh and on its one-second wallet tick, writing only
when they changed. Kept in memory only, never stored or sent. A sold card
missing from the next full list was cleared (EA's Clear Sold, in EA or on
Nova AI's page): the Sold counter keeps counting it (`soldCleared`, since
the page loaded), so clearing never takes sales off it, while the panel
shows only what is still on the list.

The **Transfer list** panel has two small tools (automation builds,
`content/transfer-tools.ts`), one at a time, each saying what it did under
the panel:

- **Clear sold** (when the list has sold cards): the adapter's `clearSold`
  act, the web app's own Clear Sold, then a reload of the list.
- **Relist unsold** (when it has unsold cards): **Same** is the adapter's
  `relistAll` act, the web app's own Re-list All (one request, every
  expired card at its last prices), then a reload. **−1 step** / **+1 step**
  read the list's unsold cards (the `unsold` act, which keeps their
  entities) and list each again with the `relist` act, one at a time 2.5–4.5
  s apart (never a burst EA answers with its limits): the buy-now price one
  step of EA's grid from the card's last one (never under 200), the starting
  bid one step under it, for an hour, as auto-sell lists. The adapter only
  relists a card that read returned as unsold, once (`relist_not_unsold`
  otherwise). A card listed without a buy-now price is left as it is; three
  refusals in a row stop the run. The counts follow with the reload after.

The Profit, Searches, Bought, Missed and Coins spent figures and Top snipes
count everything since the page loaded, across Stop and Start, like the
Activity log beside them; the reset button clears both. "Stop after N
purchases" and the session coin budget count each run on its own.

The bot (`engine/sniper.ts`) searches the user's saved filters in turn, buys
every listing at or under the price cap (cheapest first), and starts the next
search a random delay from the user's range after the last one started (start
to start, so EA's answer time and any buying come out of the delay rather than
being added to it), with breaks every N searches and rests every N
minutes. Nothing after a buy holds the bot up: the buy counts at once, its
sell price and profit fill in when their lookup answers, and auto-sell's
listing (a FUTBIN lookup and EA's listing call) runs on its own while the
bot goes on to the next listing and search; only the user's own "Pause
after a buy" (Safety, 10 s by default, 0 for none) waits, and after it the
rest of that search's listings are left (they are that pause old): the next
search looks again. A listing the bot can buy is bought the moment it
reaches content (its `auctions` or `listings_buyable` message), without
waiting for the search's own signed answer: the adapter checks every buy
against the listing it saw itself (`priceCheck`: price, card, expiry), so
an `auctions` message, which any page script could post, can never make
it buy anything else. Each bought or missed buy's log line gives the
bot's reaction time (listing in to buy out), and each attempt's telemetry
carries where the time before the buy went: `searchMs` (search sent to the
listing arriving) and `reactionMs` (listing arriving to the buy sent), next
to `latencyMs` (the buy's own round trip), cut to the schema's bounds by
`attemptTiming` (`sniping_activity.search_ms` / `reaction_ms`, migration
0038). Every two minutes while it runs, content sends the bot's pace
(`Sniper.takePace`, `botPaceSchema`) as a `heartbeat` activity event:
searches sent, with listings and failed, the search round trip's median
and 90th percentile, and the time spent in the search delay, EA backoff,
limits, breaks and the pause after a buy. A search that finds nothing is
reported nowhere else, so this is what shows the real search pace. The
minimum-profit check never
waits on the network: the sale price is `plannedSalePrice`, the price
auto-sell lists at (the user's own sell price when set, else the market
price), less EA's 5% tax; a market price counts only once its lookup has
answered (looked up at Start for the search's player and after every search
for its listings' cards, 20 at most, reused for 2 minutes and decisive for
10), and an unknown one is allowed. A missed buy's log line gives the
reason in plain words (`missReason`: "someone else got it first" for EA's
403 / 461 / 478, "not enough coins", a verification, EA limiting requests),
never EA's wording or the timings, which stay in the attempt telemetry: its
outcome there is `too_slow` for EA's 403 / 461 / 478 and a listing already
gone, `error` for 429 and 5xx (512, 521), `failed` otherwise
(`missOutcome`), its `errorCode` cut to the schema's 80 characters. EA
answers a search it was just asked, word for word, from its cache, so each
search steps its max buy-now price one notch down EA's price grid from the
price cap (`searchMaxBuy`), up to five steps and 10% of the cap under it
(never to the filter's own min), then over again; with no cap it steps down
from EA's highest buy-now price. Every search in a cycle is one EA was not
just asked, the cheapest listings are in every one, and only the dearest few
steps under the cap are left out, by some searches of each cycle (earlier
builds stepped the min price up instead, which hid the cheapest listings).
It ships through the same `virtual:autobuyer-loader` alias as the
autobuyer (`loadSniper()`), so the `ledger` build never contains it, and the
autobuyer does not buy while the bot runs.

**Recommended limits, editable, with a live risk level.** The settings
(`BotSettings` in `@sl/shared`) live in `storage.local`, never on the
server. They start on the recommended limits (`RECOMMENDED_BOT_SETTINGS`):
a random 8–12 s search delay, at most 250 searches and 15 buys an hour, a
60-minute session then a 20-minute rest, at most 6 active hours a day, at
most 500,000 coins spent an hour, and a 10 s cooldown after every buy. The
user can change any of them within `BOT_LIMITS` (the hard technical
bounds); "Reset to recommended" restores them. "Short bursts"
(`withShortBurstLimits`, `SHORT_BURSTS_BOT_SETTINGS`) fills in fast short
sessions instead: 4–6 s between searches, a 15–30 s break every 40–60
searches, 10–15 minutes of searching then a 10–20 minute rest, at most 450
searches an hour and 6 active hours a day (rated moderate, so it asks for
the acknowledgment); both keep the user's targets, thresholds and
auto-sell. Settings saved by older
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

Buys an hour, coins an hour and the buy:search ratio count buys that
bought: a buy EA turned down (a lost race, a signed refusal) gives its coins
and its place back (`Governor.releaseSpend`; an unsigned or timed-out
answer stays charged until EA's signed late answer settles it). The
governor's actions an hour (max searches + max buys) still counts every
request EA saw, the ban-risk backstop. The ratio runs on the bot's own
rolling one-hour search and buy windows (`ratioCounts`), counting a cold
start as at least ceil(1 / ratio) searches, so the first buy of a start is
allowed and the ratio never banks a long history. While one of these holds
buying back, the page says which, with the numbers and when it frees
("Buying paused: coin-flow limit (412,000 of 500,000 coins in the last
hour) — resumes about 02:14", `SniperState.notice`, under Start and as the
header chip's title); it is reported once when it starts (one `riskEvents`
item, `coin_flow`, `actions_per_hour` or `buy_search_ratio`, with its value
and threshold) and as one `blocked` attempt per search at most, and the rest
of that search's listings are left. While buys an hour, the coin flow or the
governor's actions an hour are full the bot does not search at all: it
sleeps until the window frees (a minute at a time, re-checking), and that
time does not count toward the active hours a day. The ratio does not stop
searching: more searches are what lower it. The Settings tab shows the pace
the bot really searches at under the search delay (`effectiveSearchPace`:
min(max searches an hour, 3600 / the middle of the delay range)), and when
the hourly limit will pause a faster delay.

While the bot runs, content leaves the assist side alone: no ranking and no
`summary` lookups on its searches or on the engine tick, and its searches
do not count against the shared assist governor (`countObservedSearches`
gets no governor); the bot's own governor counts them.

**Background tabs.** The bot's waits are timed in a small dedicated worker
(`lib/background-timer.ts`), not on the page's own timers, which Chrome
throttles in a hidden tab (to about once a minute after five minutes), so it
keeps its pace minimised or behind another tab. If the page's CSP refuses
the worker, or it stops answering (a page-timer backup ends any wait it misses
by 5 s), the waits fall back to `setTimeout`; the log says at Start which mode
is in use. While the bot runs the page holds a shared Web Lock
(`nova-ai-running`), which Chrome does not freeze. A tab Chrome discards to
save memory still stops everything: add the EA web app to Chrome's "Always
keep these sites active" list.

**Auto-sell** (off by default; `BotSettings.autoSell`). After each buy the
bot lists the card on the transfer market for an hour: at the market price
moved by the user's EA price steps (−20 to +20), or at a fixed price. The
fixed price is typed in the Search card, right under the max buy price
(empty means the market price), with a live line under it: what the sale
leaves after EA's 5% tax and the profit per card at the max buy price
(`saleProfit`, i.e. `computeTradeProfit` from `@sl/shared`). The
market price is FUTBIN's lowest buy-now for the card on the chosen platform
(`price.futbin`, `background/futbin.ts`; `www.futbin.com` is in the
`ledger-auto` host permissions and the userscript's `@connect`), else the
second cheapest listing Nova saw still on the market in the last half hour
(`recentMarketPrice`, `model/market-price.ts`, returned by `summary` as
`market`; unknown with fewer than two), never the week's median, which ran
far above what cards sell for. FUTBIN has no public API, so anything that
doesn't read like its player-prices JSON counts as no price. A buy's "sells
for" and profit, and the minimum-profit check, use the price auto-sell lists
at: the user's own sell price when set (even with auto-sell off), else the
market price, moved by the steps when auto-sell is on.
Prices go on EA's grid (`roundToPriceStep` / `stepPrice` in `@sl/shared`),
the starting bid one step under the buy-now. "Never sell at a loss" (on by
default) skips a price that, after EA's 5% tax, is below what the card
cost. Every outcome is in the log. The listing itself is the adapter's
`list` act (`services.Item.list(item, start, buyNow, 3600)` in the
observable shape, UNVERIFIED like the rest of it; the promise shape has
none and answers `list_unsupported`), and the adapter only lists an item
it bought itself on that page load (`list_not_bought` otherwise). The
transfer list reload is the adapter's `pile` act
(`services.Item.requestTransferItems()` in the observable shape, what the
web app is said to call when its Transfer List opens, UNVERIFIED; the
promise shape answers `pile_unsupported`). The Transfer list panel's tools
use `services.Item.clearSoldItems()`, `services.Item.relistExpiredAuctions()`
and the same `requestTransferItems()` for the list's item entities
(UNVERIFIED as well; the promise shape has none of them).

**Bid mode** (`engine/bidder.ts`, run by `engine/sniper.ts`'s `runBids`).
Above Start the user picks **Snipe** (what the bot always did, the
default) or **Bid**; only one runs at a time, and the choice is locked while
the bot runs (it applies at the next Start). Bid mode bids on auctions in
their last minutes and never above the search's own max price, which in
Bid mode is the max bid (the page says so under the Buy Now price, and
asks for one before Start; "Most you'll pay" caps it too):

- **What it goes for** (`pickAuctions`): an auction whose buy-now price is
  at or under the max is bought with Buy Now, through Snipe mode's own buy
  path and limits, whatever its time left. Otherwise it bids only on an
  auction with at most `bidding.windowMinutes` left (5 by default, 1–60),
  and only when the next valid bid is at or under the max and under the
  buy-now price: the starting bid while nobody has bid, else one step of
  EA's price grid above the current bid (`nextBid`, `stepPrice(bid, 1)`: 50
  coins under 1,000, 100 up to 10,000, 250 up to 50,000, 500 up to 100,000,
  then 1,000). The lowest bid first, and at the same bid the auction ending
  soonest, while fewer than `bidding.maxActiveBids`
  auctions hold one of its bids (10 by default, 1–50; EA's watch list holds
  about 50 cards) and the watch list has room.
- **Searching**: by current bid, not buy-now price: the search's max price
  goes out as EA's own `maxBid` criterion (a separate field of the `search`
  act, never a filter field), stepped down EA's grid like Snipe mode's max
  buy-now price so EA never answers from its cache, with no max buy-now.
- **Following its bids**: every bid lands on the watch list (EA's Transfer
  Targets), which the bot reads through the adapter's `watchlist` act while
  it has open bids: at least every 20 s, at most every 5.2 s (the adapter's
  own floor is 5 s), and every cycle (within that) once a bid ends within
  90 s, was outbid or has no answer yet, or every open bid is taken.
  Outbid: it re-bids the next step while that stays at or under the max
  ("Outbid on … — re-bidding 12,500"), else drops the auction ("Max bid
  reached on … — dropping it"); several at once go soonest-ending first. A
  re-bid EA refuses because someone else's bid got there first (403, 461 or
  478, or the adapter's `price_mismatch`) is still followed ("… not
  accepted: … — checking it again"): the next read gives its new price and
  it bids again. It lets an auction go only when the next bid would pass the
  max (or the auction ended). A bid EA takes makes the trader's own bid the
  auction's current bid at once. A refused re-bid means someone's bid is at
  least that amount, so the bot bids one step over it at once ("Outbid on …
  at 7,600 — re-bidding 7,700") rather than a read later; refused again,
  the next read says where it stands.
- **Re-bids on fresh prices, fast**: after a watch list read comes back, and
  between re-bids, the next re-bid or read waits only 1.5 s
  (`REBID_GAP_MS`, slower after EA limits it), whatever the search delay.
  Searches and new bids keep their own pacing. A re-bid goes out only on a
  read at most 4 s old (`REBID_FRESH_MS`); the rest wait for the next read,
  which is due at once (5.2 s after the last one started). Live, eight bids
  outbid at once were re-bid 4 to 5 s apart on a long search delay, and the
  last ones were refused on prices 20 s old while the Active bids tab said
  "checked 42 s ago". An auction the trader was outbid on is lost once it
  is 2 s past its end, and its slot frees for a new bid at once ("Lost … |
  it ended at 9,800 or more"). One that ended while leading reads "Ended,
  confirming" until the next read says won (moved, listed, counted) or lost;
  either way it leaves the tab.
- **A live watch list**: `requestWatchedItems` answers from the web app's
  cache. Live, five bids read "leading, 0:24 left" for minutes while they
  were outbid and ended, and all showed lost at once when the cache ran out
  (8,500 and 11,250 among them, under the 12,000 max). So each read in the
  observable shape clears the market cache, reads the list, has EA refresh
  the running auctions (`services.Item.refreshAuctions(items)`, what
  community autobuyers call between two reads; UNVERIFIED), and reads it
  again; without that call, when it fails, or when it has not answered in
  4 s, the first read stands. The
  bot also tells a cached answer apart: a running auction with the same
  seconds left as the read before keeps counting down from where the last
  fresh read put it, rather than jumping back. When every running auction
  reads that way, the log says once "EA answered your watch list from its
  cache: …" and the Active bids tab adds "EA answered from its cache".
- **Balance between the bids and the market**: with every open bid taken
  (`bidding.maxActiveBids` or a full watch list) a cycle only checks the
  watch list and re-bids: no search, and its wait says "Checking your bids",
  not a search countdown. Below the max, a lost or dropped bid is replaced
  from the market at the next search: searches go a search delay apart,
  start to start, and the bid on a search's results, the watch list reads
  and the re-bids go in between, each a quick gap (40% of the search delay,
  at least 2 s, never more than the delay) after the request before. A bid
  in its last minute is then read every three quick gaps or so (a search,
  its bid, the read) instead of every 5.2 s. Live, holding the search back
  whenever any bid was in its last minute left the bot only checking for
  minutes, and 10 of 10 open bids became 3, then none. No break or rest
  starts while a bid ends within 60 s, was outbid or has no answer yet; a
  rest that comes due lets the open bids finish and what they won reach the
  transfer list first, with no new bids, then starts. Live, with 12 of 12
  bids open, the bot read the watch list once a minute, re-bid one search
  delay at a time and kept searching, and lost 10 leads at once. It keeps the watch list clear of finished auctions the trader did
  not win (expired, or lost to another bid), as Transfer Targets' "Clear
  expired" does: the adapter's `clearExpired` act takes off only what its
  last watch list read saw that way, never a won or running auction
  (`services.Item.untarget(items)` in the observable shape, UNVERIFIED; the
  promise shape has none). It clears when a session starts, every 5 minutes
  while it runs, and at once when the list is within 10 of EA's 50 ("Cleared
  N expired items from your watch list (Transfer Targets)"). A page without
  the call says so once and leaves them for the trader's own "Clear
  expired". A watch list still full (of running or won auctions) stops new
  bids, and the bot once none of its bids is left on it.
- **What it wins** is a purchase like any snipe: the Bought, Coins spent and
  Profit figures, a `success` attempt and a `bought` trade (with the item id
  the watch list gave, `TradeInput.itemId`), which the sale tracking follows.
  It is then moved to the transfer list (the adapter's `move` act) and, when
  auto-sell is on, listed exactly like a sniped card; with auto-sell off it
  stays there unlisted ("Moved … to your transfer list"). Won cards queue
  (`collecting`): one step (a move, or a listing) per cycle, each waiting its
  turn like any other request, and a step EA refuses is tried again on a
  later cycle, up to three times. Stopping the bot says which won cards were
  not moved or listed yet, and where they are. Where it cannot be
  moved (the promise shape has no move call) it stays where EA puts it, in
  the watch list, and the log says so. A lost or dropped auction is a miss
  (one `too_slow` / `failed` attempt with `errorCode` `outbid` or
  `max_bid_reached`); the bids themselves are not attempts. No API or
  telemetry schema changed.
- **Limits**: every Snipe mode rail applies unchanged (the search delay
  start to start, breaks, rests, active hours a day, searches an hour, the
  kill switch, plan, account and engine lease checks, and EA's rate-limit
  backoff, slow-down, protective rests and soft-ban stop, for errors on its
  bids and watch list reads too). Its own: **bids an hour**
  (`bidding.maxBidsPerHour`, 60 by default, 1–300: every bid and re-bid EA
  saw, on its own sliding window saved with the hourly budgets as
  `bidTimes`), which the governor's actions an hour also counts (raised by
  that many while Bid mode runs: kind `bid`, §5). EA holds a bid's coins
  while it leads, so the coins the bot's standing bids hold count against
  the session coin budget, against the balance EA's own answers last stated
  (whether that balance already leaves them out is unverified, so they may
  be counted twice: that can only skip a bid, never send one EA refuses for
  coins) and in the governor's coin flow until a bid is outbid or lost; the
  minimum profit is checked at the bid. Bids are not buys for the buy:search
  ratio or buys an hour.
- **One request at a time**: every request Bid mode sends EA (a search, a
  bid or re-bid, a watch list read, a Buy Now) waits its turn after the one
  before (`paceEaRequest`): the search delay (slowed after EA limits it)
  after a search, a new bid or a Buy Now; 40% of it, never under 2 s, after
  a watch list read or a re-bid, so an outbid lead is answered in seconds.
  It places at most one new bid per search (`NEW_BIDS_PER_SEARCH`). The first
  live run sent three bids within a second of a search, and EA answered with
  521, 429 and 512.
- **Search results** never show an auction the trader leads. Each time a
  watch list read says the trader lost the lead, that auction shows there
  once ("Outbid: you lost the lead, re-bidding" with the re-bid, or "the
  next bid is over your max, dropping it"; `SniperMatch.outbid`).
- **Fails closed**: without the Bid mode calls (`bid` and `watchlist`) the
  bot will not start in Bid mode, and its first act is a watch list read: if
  the page cannot do it for Nova AI (`bidding_unsupported`) or it fails, the
  bot stops with a plain message before bidding at all; three failed reads
  in a row later stop it too. Snipe mode never needs them. Stopping leaves
  the open bids with EA (the log says so); a later start in Bid mode on the
  same page follows them again.
- **Settings**: the mode and the Bidding settings (window, bids at once,
  bids an hour; the Settings tab shows them while Bid is picked) are
  `BotModeSettings` (`botModeSettingsSchema` in `@sl/shared`), kept in this
  browser (`bot.modeGet` / `bot.modeSet`, `sl.bot.mode.v1`), **not** synced
  with the account: `PUT /extension/bot-settings` validates `BotSettings`
  strictly, so adding fields there needs the API deployed first (and an
  older extension then refuses the API's answer). A missing or unknown mode
  reads as Snipe.

The page shows the open bids while Bid mode runs ("Running for 3:21 ·
Active bids: 4/10") and Bid mode's log lines name the card in the sentence
("Bid 12,250 on Kika Nazareth (3 min left)", "Won Kika Nazareth for
12,500"); the Auto-sell card says it covers both modes. Beside Search
results, an **Active bids** tab (the one the page opens on in Bid mode;
"10/10" on the tab) lists every open bid soonest-ending first
(`Sniper.getActiveBids`): the card, Leading / Outbid / Waiting for EA, the
current bid, the time left counting down each second (amber in the last
minute, red in the last 30 s), and what happens next ("Your bid is the
highest · max 12,000", "re-bidding 11,750", "Next bid 12,250 is over your
max"). Its first line sums them up: "10 of 10 open · 7 leading · 2 outbid ·
62,900 held · checked 3 s ago". That's each auction as the last watch list
read saw it. After a stop the bids stay listed (EA keeps them) with "not
checked while Nova AI is stopped".

**Gallery mode** (`engine/gallery.ts`, run by `engine/sniper.ts`'s
`runGallery`) collects the cards FC 27's Gallery Sets need. EA's web app has
no Gallery, so Nova cannot read a Set or its grade: the trader picks
**Gallery** above Start and pastes the cards on the Search tab, one a line
as the player's name and the card's rating ("Hugo Ekitiké 85", the rating
first works too), with `# Set name` (or a line ending in `:`) heading the
cards under it. Two versions of a player can share a rating (a normal 85
and a Signature 85): the version after the rating ("Hugo Ekitiké 85
Signature"), named as in EA's Rarity list (the Search tab's Rarity list;
an exact name, else the only one holding it), buys only that version. Its
searches carry EA's own Rarity filter, the first one names the version's
own card id, and from then on only listings of that exact card are bought
and priced. Without a version, any version at the rating is bought (the
cheapest). **Load list** finds each name in EA's own player list (the
catalog): an exact name wins, else the only player whose name holds it;
among namesakes, the one whose base card rates highest at or under the
rating. Lines it cannot read are listed under the box ("Line 3: no player
named …", "… matches more than one player … write the full name"), and the
rest load. Loading the list again keeps the progress of every card already
on it (same player, rating and version), so a finished card is never
bought twice. **Retry skipped** puts the
skipped cards back to buy; **Clear list** empties it.

**fut.gg Sets** (over the list box) fill the list without typing.
**Browse fut.gg Sets** reads fut.gg's Gallery (`background/futgg.ts`,
`gallery.futggSets`: the JSON fut.gg's own Gallery pages load,
`/api/fut/gallery/fc27/hub/`; `www.fut.gg` is in the `ledger-auto` host
permissions and the userscript's `@connect`), which carries, for every Set
and grade, the cheapest lineup that reaches it from fut.gg's own solver: its
cards (EA card ids), its price in all, its dearest card and its score, bonus
tags included. The picker has a tab per grade (**S**, A, B, C, D; S first):
each lists the Sets fut.gg has a lineup for at that grade, under fut.gg's
categories in fut.gg's order (Rarities, Premier League / Barclays WSL, …),
cheapest first, with what that grade costs and the Gallery Tokens it gives.
Sets with nothing to buy are never listed. Ticked Sets, each at the grade
of the tab it was ticked on, are added with **Add Sets**: for each,
background reads the Set's card list (`gallery.futggLineup`,
`/sets/{id}/pool/`) to name the lineup's cards (player, rating, rarity,
holographic or not, score, and what the Set's bonus tags look at: nation,
club, league, positions, weak foot, skill moves), the Set's other cards
(best scores first), and the Set's bonus tags (`/sets/{category}/{set}/`).
The page then asks the club (`owned`: the web app's own
`services.Club.search` with the card ids in `defId`, as its Player Picks
screen does; loans left out) about every lineup card and then the Sets'
other cards, 100 ids at most in one read, and `addFutggLineup` puts the Set
on the list. The read always says what it found: "Added 1 Set: 15 cards ·
2 in your club already", "· none in your club", or "· your club was not
checked" with the reason under the picker. An answer that holds a player
not asked about (EA's ids: a special version is its player's base id plus a
multiple of 2^24, so other versions of a player asked about do not count)
means the search ignored the card filter and answered with the club's
first page: the adapter refuses it (`owned_unfiltered`) instead of reading
it as "none owned", and every card stays to buy. A Gallery run's own check
at Start logs its result the same way ("Gallery: checked your club: none of
the 12 cards still to buy are in it").

- lineup cards the club holds are **In your club** (`owned`): they count for
  the Set as they are, so none is bought;
- a player the club holds who is on the Set's card list but not in the
  lineup **stands in** for a lineup card still to buy, dearest first
  (`planFutggSwaps`), when he scores at least what that card scores and the
  Set still makes its grade with him. The Set's score is worked out as
  fut.gg works it out (`engine/gallery-score.ts`: the cards' scores plus
  each bonus tag's share of the matching cards' scores, rounded down; it
  gives fut.gg's own score for 337 of fut.gg's 348 cheapest lineups, Oct
  2026, the rest being Sets of many special cards), and trusted only when it
  gives fut.gg's score for fut.gg's lineup: otherwise, or with a tag rule it
  does not know, nothing is swapped. The page says which player stood in
  for which card and about what it saves.

The remaining cards are **exact** (`exact: true`): only that card id is
bought, priced and listed, since a holographic copy shares the rating and
the rarity and scores more, and the score is what the grade needs. A
special card's searches carry its rarity when EA's Rarity list has it; a
gold card's never (fut.gg gives every gold card rarity 0, even a newer one
with its own id). fut.gg's price is kept as the market price of last resort
(`guide`: after FUTBIN and Nova). A card two Sets share is on the list once
and counts for both (`setIds`), as EA counts one card for several Sets.
Every Gallery run asks the club again before its first search, for the
cards still to buy (unless the page did in the last minute); a club that
cannot be read means every card is bought, as before.

A Set whose cards are all collected (in the club, listed, or owned) is
marked **completed** (`completed`, the log says to finish it in the game);
**Mark completed** does it by hand. When is kept too (`completedAt`, by Set
id), and the picker, the list and the Gallery tab say it by the trader's own
day ("Completed today", "Completed yesterday", "Completed 20 Oct"; nothing
for a Set marked before the time was kept). A completed Set is not offered
again (the picker shows it with **Undo**, and so does the list), and its
cards still to buy are left alone ("left out (Set completed)") unless another Set needs
them. Each Set on the list shows under the picker ("Malaga CF · grade S · 4
of 15 collected", with **Mark completed** and **Remove**, which takes off its
cards unless another Set holds them or they are on their way) and atop the
Gallery tab ("grade S needs 900 points, the lineup makes 908 · 4 of 15
collected", and, when cards were skipped, their points and that the Set may
miss its grade). fut.gg's cards stay out of the list box, and **Load list**
keeps them. fut.gg documents no API: anything it answers that does not read
like its Gallery JSON is no Sets, and its answers are reused for ten
minutes.

One card at a time, in the list's order, under every limit Snipe mode has
(the search delay start to start, breaks, rests, EA's backoff, the
governor):

1. **Its version.** A player's base card has the player's own id; for any
   other rating, a look-only search of the player at that rating (no max
   price, nothing bought) names the version listed (the base card if it is
   among them, else the one listed most). None listed in two looks: the
   card goes to the end of the list, still to buy ("none listed at this
   rating right now: Nova tries again after the other cards").
2. **Its market price**: FUTBIN's for that version, else Nova's own market
   data, else fut.gg's (a fut.gg Set's cards), else the cheapest listing
   those looks saw.
3. **Under the market price for 1 minute** (`GALLERY_SNIPE_MS`): searches
   with the max one EA price step under it, buying the cheapest match. Then
   **the cheapest listed**: the max starts at the market price and, after
   each search that found none, goes 1, 2, 4, 8… EA price steps over it
   (`galleryMarketCap`; a race lost leaves it where it is), and the cheapest
   match is bought. **A card is never skipped for its price**: the only
   limit is the list's budget (the page's max buy price plays no part in
   Gallery mode). Once the max is all the budget allows and still nothing,
   a look-only search with no max shows whether the card is listed dearer
   (the bot stops, `gallery_budget`, and the row and log say its cheapest
   price: "Cheapest listed: 4,000 coins, over the 1,300 coins left of your
   Gallery budget") or not at all (it goes to the end of the list, as
   above). Only one copy is bought; no minimum profit applies (each card is
   bought to collect and sold back for about what it cost). After a buy EA
   turns down (someone else's landed first), nothing more is bought from that
   search: the next listing used to go out about 200 ms later, and EA
   answered it 429, 521 or 426 (too many requests) every time; the next
   search, a search delay later, looks again. A buy EA does not
   answer in time holds the card until EA's late answer settles it (up to a
   minute), so it is never bought twice.
4. **To the club, then back on the market**, a step every 3–6 s (about as
   long as doing it by hand: at 1.5–3 s a buy and its three steps came as a
   burst, and EA limited the account), each waiting out any EA backoff or
   rest first, and a rate limit EA answers a step with (429, 512, 521)
   counting like a search's (backoff, slower searches, rests): the
   adapter's `club` act (`Item.move(item, ItemPile.CLUB)`, the web app's own
   "Send to My Club"), then `move` to the transfer list and `list` one EA
   price step over what it cost (`galleryListPrices`), with a starting bid
   a step under that. From about 2,000 coins EA's 5% tax is more than one
   step adds (a 2,900 card listed at 3,000 brings back 2,850), so such a
   card is listed at the lowest price whose sale brings back what it cost
   (3,100; 9,800 for 9,300), and the log says so. A step EA refuses is
   tried three times. A card the club refuses (EA refuses a card the club
   already holds) still goes back on the market, so its coins come back,
   and its row says "Not sent to your club (…): check the Set counted it".
   A card's trade is kept (`tradeId`) until it is listed: a card the bot
   stopped on, or one EA refused a step for, is picked up again from that
   step at the next Start. After a page reload the adapter no longer holds
   it (`club_not_bought` / `move_not_bought`), and its row says to send it to
   the club and list it by hand; **Listed it myself** on its row marks it
   done.
   EA's help ("How do Gallery Sets work in EA SPORTS FC 27?") says a card
   that passes through the club still counts toward the Gallery after it is
   sold, and that one card can count for several Sets. The trader then adds
   the cards to each Set in the game (the Set's Autocomplete, then Confirm
   Changes): the web app has no Gallery, so Nova cannot.

The list's **budget** (coins, under the list) caps what its buys spend:
the bot stops (`gallery_budget`) at a card whose cheapest listing costs more
than what is left, or once less than EA's lowest price is left. Sales do not
add back to it; **Reset spent** zeroes it. **Reset stats** (over the
session's numbers) also clears the list of what is finished
(`clearFinishedGallery`): done cards no Set in progress counts, cards
bought on an earlier page load that Nova can no longer finish, and the
completed Sets (still marked completed in the picker), and zeroes spent;
cards still to buy, the cards of Sets in progress and cards Nova is still
finishing stay. The bot stops on its own when
every card is listed or in the club (`gallery_done`), and refuses to start with
no card left to buy (`no_gallery`) or on a page that cannot send cards to the
club (`gallery_unavailable`). The list and every card's progress (to buy,
bought, in club, listed, in your club already, with what it paid, its
market price, what it listed at and why it waits), the Sets on it and the
Sets marked completed are saved after every change, in this browser and on
the account (`bot.galleryGet` / `bot.gallerySet`, `sl.bot.gallery.v1`; see
"Gallery mode's list follows the account" above). A card bought but not yet
listed when the bot stops is finished at the next Start on the same page load; after a
reload the adapter can no longer move it, and its row stays at Bought / In
club for the trader to finish. Beside Search results a **Gallery** tab (the
one the page opens on in Gallery mode, "3/20" on it) lists every card with
its step, the price it paid and the price it listed at, the one being bought
marked "Buying now", grouped: To buy, On the way to the market, Skipped,
Done; its first line sums the list up ("12 to buy · 6 listed
· 0 on the way · 2 skipped · spent 41,200 of 100,000"). Buys and sales are
reported like any other (`onAttempt` / `onTrade`), so the trader report
shows them.

**The page is laid out like EA's "Search the Transfer Market" screen**: a
back arrow and title on EA's navy bar, the pitch artwork behind two floating
panels, and on the left one EA's tab row (Search / Settings; Start waiting on
the risk confirmation links to Settings), then Reset beside the gradient
Start button at the bottom.

**Snipe targets are built like EA's own search panel**: "Type Player Name"
(with EA portraits), then Quality, Rarity, Position, Chemistry Style,
Country/Region, League and Club two to a row, then "Rating:", "Buy Now
Price:" and "Sell Price:", each with its own Clear and EA's Min:/Max: boxes
between − and +.
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

| What       | The web app's own                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search     | `services.Item.clearTransferMarketCache()` then `services.Item.searchTransferMarket(new UTSearchCriteriaDTO(), page)` -> observable; `res.data.items`                                                 |
| Buy now    | `services.Item.bid(item, auction.buyNowPrice)`                                                                                                                                                        |
| Club       | `services.Item.move(item, ItemPile.CLUB)` (Gallery mode; the same call moves a card to the transfer list with `ItemPile.TRANSFER`). Not yet checked live                                              |
| Club read  | `services.Club.search(new UTSearchCriteriaDTO())` with `defId` a list of card ids -> observable; `res.response.items`, each `definitionId`, `isLimitedUse()` true for a loan (Player Picks' own read) |
| Criteria   | `type` (set first), `maskedDefId`, `level` (`bronze`/`silver`/`gold`/`SP`), `rarities`, `position` / `zone` (130-132), `playStyle`, `nation`, `league`, `club`, `minBuy`/`maxBuy`, `ovrMin`/`ovrMax`  |
| Items      | `definitionId`, `databaseId` (base player id, read as the listing's `assetId`), `rating`, `getAuctionData()` -> `tradeId`, `buyNowPrice`, `expires`                                                   |
| Navigation | `.ut-tab-bar-item` buttons, Transfers has `icon-transfer`; top bar `.ut-navigation-bar-view`                                                                                                          |

The adapter waits for the web app to start (and log in) before its first
probe, and builds the catalog then.

The transfer list, sold and unsold counts on the Nova AI page do not use the
web app's services: they come passively from its trade-pile responses (see
"The Sniping Bot page" above). The reload that keeps them current and the
Transfer list panel's Clear sold and Relist tools do, through calls not in
this table yet (`requestTransferItems`, `clearSoldItems`,
`relistExpiredAuctions`, `list`): check `servicesKeys.Item` in **Copy
diagnostics** lists them as `"function"`, and the log `clear sold ok`,
`relist all ok`, `unsold read ok` and `relist ok` after using each.

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
  result that records the trade. An adapter _refusal_ (price mismatch,
  unknown listing, no entity, no act key) never reached EA, so the
  governor refunds what it charged for it.
- The card id is `resourceId`, `definitionId` or `maskedDefId`, never
  `assetId` (the base player, shared by every version of a card).
- The observable shape has no verified trade-status call, so `readResult`
  fails loud. (Nothing calls `readResult` today.)
- The promise shape treats a resolved `buyNow` as success unless it says
  `success: false`; the observable shape needs an explicit `success: true`.
- Nova AI's Bid mode (automation builds only: `bidding` on each shape, which
  the listable build does not carry) is checked on its own, so a page
  without it still snipes and only Bid mode refuses (`bidding_unsupported`).
  Observable shape: `services.Item.bid(item, amount)` to bid (the buy call
  with a bid amount), `services.Item.requestWatchedItems()` for the watch
  list (seen live answering `{ success, status, error, response, maxAge,
retryAfter }`, the list inside `response`), `services.Item.move(item,
ItemPile.TRANSFER)` to move a won card. Promise shape:
  `services.Transfer.repository.bid(tradeId, amount)` and
  `services.Item.repository.watchlist() -> { auctionInfo }` (a pure guess),
  no move. Watch list entries are read like listings plus EA's `bidState`
  (`highest` / `outbid` / `none` / `buyNow`) beside `tradeState`, also
  under a leading underscore on an entity (`normaliseWatchedItem`). The
  adapter bids only exactly the next valid bid on an auction it saw in one
  of EA's own answers (a search or a watch list read: `bidCheck`,
  `nextBidPrice`), under its buy-now price; refuses a second watch list read
  within 5 s (`watchlist_too_soon`); and moves or lists only an auction it
  bid on itself on that page load that the watch list says it won
  (`closed`, `highest`). The watch list is never forwarded to the trade
  lifecycle.

**Day-one checklist**, once the market unlocks and the real web app is
reachable:

1. Load the extension, sign in, and open the real FC web app. Go to the
   transfer market and run one search by hand in EA's own UI.
2. Open the extension's options page (right-click the toolbar icon →
   Options) and click **Copy diagnostics** under _Diagnostics_. It asks the
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
   version (not the base player's `assetId`). The name the assist confirm
   overlay shows is assumed to be `itemData.name` (or the entity's `name`);
   when it is absent the overlay shows `#resourceId` instead.
7. Only once 1–6 pass: flip a test account to a `ledger-auto`-entitled plan
   and watch one real, human-confirmed assist buy (Alt+B, then Alt+B again
   or Confirm on the overlay; M2, not M3) go
   through (`buy ok (<shape>)` in the log) before trusting the automated
   loop at all. Confirm what a _failed_ buy looks like too (outbid or
   expired listing): it must show as `buy failed`, never `buy ok`. Note
   how long a real `bid` takes to answer: a `timeout_unknown` in the log
   means EA took over 12 s, and a following `late buy answer` line says
   how it went. Several of those mean the limit is too short.
8. **Trade pile (profit capture, lib/trade-lifecycle.ts).** All assumed:
   - The paths `/ut/game/<title>/tradepile` (a successful answer with no
     list there is a trade-pile shape change, which stops nothing; an error
     status, EA's `{ code, reason }` envelope or an empty answer is an
     `ea_error`), `/item` and `/auctionhouse/relist` (only logged).
     `/watchlist` and `/trade/status` are deliberately not read: they show
     auctions the trader won or bought as `closed` at the price paid, which
     is a purchase, and was once misread as a sale.
   - The envelope `auctionInfo` (also read: `data.auctionInfo`, `items`,
     `data.items`, a bare list, and an item move's `itemData`); the item id at
     `itemData.id` (an entity's `id`), and the same id on a market
     listing's `itemData`.
   - `tradeState` of `active`, `closed` (sold) or `expired`, null or absent
     when unlisted, with `tradeId` 0. A sold listing's price is its
     `currentBid` (falling back to `buyNowPrice`). **A card must be seen
     listed (active or expired) at least once for its sale to count**;
     after that, any `closed` tradeId of the card other than the one it was
     bought on is its sale, even a relist never seen active (e.g. "Relist
     all"). The tradeId it was bought on is never a sale.
   - A plain GET of `/tradepile` in which every entry was readable is the
     whole transfer list: a listed card missing from it sold (reported at
     its list price, `saleSource: 'inferred'`), an expired one is marked
     gone and never reported (§6, "Trade lifecycle"). An entry with a price
     outside 0–15,000,000 is skipped, so that response is not treated as
     full.
   - `soldAt` is when the sale was _seen_ on the pile, not when it
     happened (EA gives no sale time), clamped to be no earlier than the
     purchase.

   To check: open the transfer list in EA's UI, then **Copy diagnostics**
   and read `lastTradePileResponse` (path, keys and types) and `lifecycle`
   (`buysWithoutItemId`, counted per browser session, above 0 means
   market listings carry no item id).
   Then list a card an engine bought, let it sell, reopen the transfer
   list, and confirm the dashboard shows that trade `sold` at the right
   price. `trade pile:` lines in the log mean one of the above is wrong. A
   card bought outside the extension is never followed (no buy price to
   close it with).

9. **Bid mode (Nova AI, automation builds).** All assumed:
   - With a test account, bid on one cheap auction by hand in EA's UI, then
     start Nova AI in Bid mode on a search with a low max price and **Copy
     diagnostics**: `servicesKeys.Item` should list `bid`,
     `requestWatchedItems` and `move` as `"function"`, the log
     `watchlist ok (<shape>): N auctions` (N matching EA's Transfer
     Targets) and, after a bid, `bid ok (<shape>)`. `lastMarketResponse`
     with `source: "act:watchlist"` shows the watch list's keys: each item's
     auction should carry `bidState` and `tradeState` (or `_bidState` /
     `_tradeState`), `currentBid`, `startingBid`, `expires`, and the item
     its `id`. `skipped N unreadable entries` under `watchlist` means a
     state or field differs: fix `normaliseWatchedItem`.
   - The search's `maxBid` criterion: Bid mode's searches should find the
     same auctions as EA's own search with only "Max Bid" set. An auction
     nobody has bid on must read `currentBid: 0` (the bot then bids its
     starting bid; were EA to report the starting bid there, it would bid
     one step more than it needs to).
   - A bid at exactly the next step must go in, and EA's answer to a bid
     that lost the race must show as `bid failed` (461 / 478 expected), never
     `bid ok`. Confirm whether EA's stated coin balance (`credits`) drops by
     a bid's amount when it is placed: if it does, Bid mode's coin check can
     stop counting the coins its bids hold a second time.
   - Win one auction: the watch list must show it `closed` with `bidState:
"highest"`, `move ok` must follow (`ItemPile.TRANSFER` is the web app's
     own pile id), then the listing when auto-sell is on. A full transfer
     list makes the move fail: the log says the card stays in the watch
     list.

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
  clock and the per-session buy/search/spend counts reset, while the
  cooldown, the one-hour windows and the kill switch do not. `resetSession()`
  does the same on demand: background's `engine.resetSession` message passes
  it to the EA tab holding the engine lease (a "New session" control, which
  no UI shows yet). A pause of more than 30 minutes with no action
  (`SESSION_IDLE_RESET_MS`, longer than any rest) ends the session too: the
  next `allow()` starts a new one. Live, a page left open overnight still
  counted the previous morning's session, and the first buy the next morning
  tripped the 90-minute length at minute 1,115. The state keeps
  `lastActionAt` for this (optional; an older saved state's newest action
  stands in). `snapshot()` already shows the new session once a tripped
  one's cooldown is over, or a session has sat idle that long, rather than
  the stale elapsed time until the next `allow()`.
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
  same search. A real human search in that window is dropped too: known and
  accepted, since nothing in the reports tells the two apart and dropping
  one only makes the ratio stricter. While Nova AI runs, observed searches
  are its own and are not counted here (they would spend assist's
  `actionsPerHour`); instead assist's governor adds the bot's last hour of
  searches and buys (`Sniper.ratioCounts`, passed as `sharedRatioCounts`)
  to its session's for this ratio only, with the bot's cold-start floor
  while that hour holds a search. Without them, every buy of your own while
  the bot ran (Alt+B, the overlay) read 1 buy per search and was refused.
- **`maxCoinFlowPerHour`** — sliding one-hour window over coins spent on
  `buy` actions specifically (added to `GovernorSettings` for this file —
  see `packages/shared/src/schemas/settings.ts`, additive/backward-
  compatible).
- **`budgets.maxCoinsPerSnipe`** (a budget, not a `GovernorSettings`
  threshold) — `setMaxCoinsPerBuy()`: a buy above it is a soft deny
  (`coin_flow`, "above your max coins per snipe"). The Sniping Bot's
  governor has none; its price cap is `thresholds.maxBuyPrice`.
- **Bids** (`allow({ kind: 'bid', coins })`, Nova AI's Bid mode only): a
  request EA sees, so it counts toward `actionsPerHour` (the bot's governor
  adds `bidding.maxBidsPerHour` to it while Bid mode runs) and passes the
  same hard stops; its coins are held in the `maxCoinFlowPerHour` window
  while the bid stands (a soft deny when the hour's spend plus the standing
  bids has no room) and come back through `releaseSpend` once it is outbid
  or lost, or EA refused it (`refund` when the adapter refused it before it
  reached EA). Never a buy for `buyToSearchRatio` or the buy count; a won
  auction's coins simply stay spent.

An allowed buy the adapter then _refuses_ before calling EA (price
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

**Settings and features in an open tab** (P0 Task 13). Settings apply
without a reload: background rewrites the settings cache
(`sl.settings.cache.v1`) from every bootstrap, heartbeat and settings save,
and an open EA tab applies each change from `storage.onChanged`
(`content/live-settings.ts`, validated with `userSettingsSchema`): the
governor's limits (clamped into `GOVERNOR_ABSOLUTE_LIMITS` as at
construction), the per-snipe cap and the autobuyer's session budget. Saved
filters arrive the same way. Features are re-read from background's cached
entitlement every 30 s, so a plan that gains assist gets its engine, and one
that loses it (or an expired offline grace) loses it, without a reload.

**Why a running Nova AI bot stops** (`content/account-check.ts`). While the
bot or the autobuyer runs, the same 30 s check tells three cases apart, so
a session that ends is never reported as a plan problem:

- an entitlement from background (a bootstrap, or its fresh verified
  cache) without `automation.autobuyer`: `not_entitled`, "your plan no
  longer includes Nova AI". Only the server's own answer can say this;
- no entitlement and no tokens left (`auth.status` `hasAccount: false`: a
  refresh was refused — session revoked, token reuse, the password
  changed — or the user signed out): `signed_out` at once, fail closed,
  "signed out of Nova Trade — sign in again to restart" (or "… because the
  password changed …" when the API said so when refusing the refresh);
- no entitlement while still signed in (the API unreachable with no
  offline grace, the service worker restarting): nothing on the first
  miss; a second in a row is `account_unreachable`.

The bot checks the account before the plan at Start and before every
action, and opening its page re-checks, so signing back in is enough to
start it again.

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
- **Trades**: each buy (its trade id, the card's resource id, rating and
  EA item id, the price and time) and later its sale (price and time, and
  whether it was seen or inferred: see "Trade lifecycle" below). The API
  computes the tax and net profit itself.
- **Filter stats**: none are sent today. Nothing in the extension produces
  them (saved filters are local only), so the filter rotation/retirement
  that would have used them was removed (P0 Task 13); the queue kind and
  `/filters/stats` stay for when filters sync to the server.
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

### Trade lifecycle: following a buy to its sale

`lib/trade-lifecycle.ts` (run by `background/lifecycle.ts` over its own
IndexedDB database, `store/lifecycle-db.ts`) keeps one record per card,
keyed by EA's item id, and walks it through the trade-pile responses the
adapter reads passively (§4 item 8). A sale goes out through the same
`trades` queue as the buy: the buy's own `tradeId`, `status: 'sold'`,
`sellPrice`, `soldAt`, the card's `itemId`, and `saleSource: 'inferred'`
when the price is an estimate. The API updates that trade and computes the
tax and net. A sale is reported once (persisted as sold before the report,
marked reported after; `resumeUnreported` re-sends one that failed).

```
bought -> listed(price) -> sold(price)       seen closed: saleSource observed
       \                \-> expired -> listed again (a relist) -> ...
        \-> sold (its listing never seen)
listed  -> sold at its list price            missing from a full trade pile:
                                             saleSource inferred
expired -> gone (goneFrom: 'expired')        missing from a full trade pile:
                                             never reported
```

- **A listed card that left the trade pile sold.** EA lets nobody remove a
  card from the transfer list while its listing is live, so a card last
  seen listed that is missing from a full trade pile (a plain GET of
  `/tradepile` with every entry readable) was bought: the trader cleared it
  from the sold items on the console or the phone app, or the trade-pile
  reads failed while it sold. Nova AI's auto-sell lists at buy-now, so it
  is recorded sold at its list price, dated when it was found missing,
  never before the purchase. It is flagged `inferred`, stored as
  `trades.sale_source = 'inferred'`, and the dashboard marks its price
  `est.`. A sale another browser later _sees_ replaces it on the server;
  nothing else does.
- **An expired card that left the pile stays `gone`**: it may have been
  quick-sold or sent to the club. The record keeps `goneFrom`.
- **Old `gone` records.** Before `goneFrom` existed, listed and expired
  cards both became `gone` and were never reported. The trader confirmed
  those cards sold, so the first `resumeUnreported` after the update (at the
  first lifecycle message after the service worker starts, and on every
  heartbeat alarm) turns each `gone` record with a list price and no
  `goneFrom` into an inferred sale at its list price, dated when it went
  gone, and reports it. Once sold, a record never goes back to `gone`, so
  this happens once per record. Records are pruned 30 days after they went
  gone, so only the last 30 days are recovered, and only in the browser
  that holds them.
- **Cross-browser.** The records are per browser, but the account's buys
  are not: `GET /api/v1/extension/open-trades` returns the trades still
  `bought` on the server that carry an item id (the buy report sends it;
  `trades.item_id`, migration 0040), bought in the last 30 days, newest 300. `TradeLifecycle.seed` adds each card this browser has no record of
  as `bought`, on that buy's `tradeId`, so a card bought on the trader's PC
  and sold while the bot runs on a cloud machine is reported against the
  original buy. A record already present is never overwritten (only a
  finished record of an older purchase of the same card is replaced). When
  the list is complete (`truncated: false`), a seeded card still `bought`
  whose trade is no longer open (sold elsewhere, marked sold on the
  dashboard) is dropped; a seeded card bought over 30 days ago and never
  seen here is pruned. Purchase times from the server are moved onto this
  machine's clock (`lib/clock.ts` `toLocalTime`), so the sale report sends
  them back unchanged.

  A buy reported before 0040 has no item id on the server. The browser
  that bought it re-sends it once, as `bought` with its item id, for every
  card it still follows (bought, listed or expired:
  `TradeLifecycle.reportItemIds`, run with `resumeUnreported`); the server
  fills in `item_id` and keeps a sale it already has. From then on the
  account's other browsers can follow those cards too.

  When it is read (`lib/lifecycle-seed.ts`, one request at a time, at most
  every 15 minutes unless a caller asks for fresher; 2 minutes' wait after
  no answer): at boot once signed in, after a sign-in, when the bot (or the
  autobuyer) starts (`engine.state` turning `running`, unless it was read
  in the last minute), every 15 minutes while it runs (the
  `sl.lifecycle.seed` alarm), and before a trade-pile read when the last
  seed is older than 15 minutes (the read waits up to 5 s for it, so the
  pile the bot's start reloads is judged with the account's cards). Never
  while signed out or opted out of telemetry. The time of the last seed is
  kept in `storage.session`. The userscript runs the same code: its
  browser shim maps the alarm to a timer and `storage.session` to its own
  store.

  **Deploy the API first**: `/trades/batch` validates strictly, and an API
  without 0040 would reject (and the queue drop) every buy report carrying
  `itemId`.

Whatever the extension never saw sell (a card bought before this, or one
that left the pile while no browser followed it), the trader records on
the dashboard: "Mark as sold" on one trade (`POST /trades/:id/close`), or
several bought trades of one card at one price (`POST /trades/mark-sold`),
both stored as `sale_source = 'manual'`.

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

**One engine per browser profile** (P0 Task 13). Each EA tab ran its own
engine, with its own copy of the hourly windows, so two tabs could spend
twice the budgets (the assist/autobuyer governor's and the Sniping Bot's).
Now only the tab holding the engine lease runs one: background keeps the
lease in `storage.session` (`background/engine-lease.ts`, `engine.lockAcquire`
/ `engine.lockRelease`), the holder renews it every 20 s (it lasts 3
minutes, so a hidden tab whose timers Chrome throttles keeps it), and gives
it back on `pagehide`. Every other tab still records, but its chords,
autobuyer and bot do nothing (the bot stops with "running in another EA
tab"). A tab gaining the lease first loads what the last holder saved
(`engine.stateGet` into `Governor.loadState`; the bot re-reads `bot.budgetGet`
on every start), and gives the lease back if background does not answer.
Only the holder saves, after every decision and every 5 s, pushes the risk
snapshot, and reports its `engine.state` for the 10-minute heartbeat (idle
once no tab has for a lease's length). Rejected alternative: moving every
`allow()` behind a round trip to the service worker, which MV3 may stop at
any moment, would put an asynchronous dependency inside every loop step.

The Sniping Bot's budget load fails closed (finding A): if `bot.budgetGet`
gets no answer (a service worker restarting), the bot does not start and
nothing is saved over the stored windows; before, the failed load counted
as "nothing saved" and the next save refilled every hourly budget.

M1 recording never depends on any of this: the engine bindings are declared
before the adapter callbacks are registered, and a failed account-gated
M2/M3 bootstrap is logged, not allowed to abort the page's recorder.

The **watchdog** (`content/watchdog.ts`) is a second `setInterval` that
tracks the last `probe` or `heartbeat` message from the MAIN-world adapter
(the adapter sends a heartbeat every 20 seconds, whatever the page does).
It warns (surfaced through the same `lib/logger.ts` ring buffer the options
page's log export reads) only after three checks in a row found the adapter
quiet for over 60 seconds — five minutes in a hidden tab, where Chrome
runs timers about once a minute — ignores a check that itself ran late
(throttled, frozen or asleep) and the first check after the tab is shown or
hidden, and warns at most once per stall and once every ten minutes. Because a
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
flushes only `warn`/`error` entries, each one once (oldest first, up to
100 per flush), to `POST /extension/errors`
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
  is never written to any storage in plaintext. A browser restart clears
  the access token but not the refresh token, so background tries one
  refresh when it starts (`lib/auth.ts` `refreshOnStartup`) and
  `isAuthenticated()` waits for it, instead of acting signed out.
- **Refreshing without tripping reuse detection.** The API rotates the
  refresh token on every use and revokes the session when a superseded one
  comes back (docs/04-auth.md §3). `lib/auth.ts` therefore refreshes under
  the `sl-auth-refresh` Web Lock (every EA tab of the userscript build runs
  its own background copy over shared storage), re-reads storage once it
  holds it and uses another context's fresh tokens instead of calling the
  API, and sends `/auth/refresh` one attempt at a time (`retries: 0`):
  after a network error, 5xx, 429 or `409 AUTH_REFRESH_CONFLICT` it checks
  whether storage changed before ever sending its token again, and only
  retries with it for 12 s — inside the API's 30 s grace for exactly that
  retry. An API that stays unreachable keeps the tokens (the caller sees it
  unreachable); only a refusal signs out, remembering why
  (`sl.auth.signedOut`) for `auth.status`. Without Web Locks (old
  browsers, tests) the per-context single-flight is all there is.
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
