# @sl/extension — Sniper's Ledger

The MV3 Chrome extension: a recorder for the EA FC transfer market (M1),
a human-in-the-loop assist layer with an opportunity ranker and a visible
risk budget meter (M2), and an optional, separately-distributed automation
build gated behind the same safety governor on every single action (M3).

Full reference (worlds, message flows, the two build targets, the adapter's
day-one verification checklist, governor thresholds and math, exactly what
telemetry sends, crash recovery, auto-update, settings sync rules and
security notes) lives in
[`docs/06-extension.md`](../../docs/06-extension.md). This file is just
"how do I build and run it."

## Two build targets

| | `ledger` | `ledger-auto` |
| --- | --- | --- |
| Contains | M1 recorder + M2 assist | M1 + M2 + M3 automation |
| Distribution | Chrome Web Store (listable) | Self-hosted (`update_url`) |

```
pnpm install
pnpm --filter @sl/extension typecheck
pnpm --filter @sl/extension lint
pnpm --filter @sl/extension test          # vitest, jsdom + fake-indexeddb
pnpm --filter @sl/extension build:ledger  # -> dist/ledger
pnpm --filter @sl/extension build:auto    # -> dist/ledger-auto
```

`dist/ledger` and `dist/ledger-auto` are both fully self-contained,
loadable-unpacked extensions (`chrome://extensions` → Developer mode → Load
unpacked → pick the `dist/<target>` folder).

## End-to-end test

```
pnpm --filter @sl/extension build:ledger
pnpm --filter @sl/extension test:e2e
```

Loading an unpacked extension needs a headed Chromium context
(`--load-extension`); this container has no display, so run it through
`xvfb-run` instead:

```
xvfb-run -a pnpm --filter @sl/extension test:e2e
```

`test/e2e/extension.spec.ts` loads `dist/ledger` against a mock EA web app
fixture (`test/fixtures/mock-ea-app/`, replaying recorded UTAS
`transfermarket` payloads and a fake `window.services` matching
`adapter.ts`'s documented ASSUMED SHAPE) and asserts the panel appears,
observations are recorded, and the bundle probe reports ok — plus a
browser-free static check that `dist/ledger` never contains the word
"autobuyer" anywhere.

## What it sends

Nothing, until you sign in. The recorder (M1) needs no account, and its
data lives entirely in this extension's own IndexedDB, never uploaded. Once
signed in, a small, typed, itemised set of product telemetry is sent — see
`docs/06-extension.md` §6 for the exact list, and the options page's own
"What it sends" panel for the same list in-product. Raw market listings
never leave the browser, in any state, signed in or not.

## Honest limits

Unchanged from milestone 1 (`model/prices.ts` is ported, not rewritten):
sell-through is an inferred estimate, not an observed one; the recorder only
knows what you searched; the first days of data on a card are noise. See
`docs/06-extension.md` and the price model's own doc comments for the
detail.
