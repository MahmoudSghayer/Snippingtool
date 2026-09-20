# Ledger

A recorder for the EA FC transfer market. It watches the searches you already
run and builds a private history of what the market actually did — the real BIN
floor, how many of a card are listed, and how often one sells before it expires.

This is milestone 1. **There is no automation in it.** It does not search, bid,
buy or list. It reads the responses the web app was already receiving and writes
them down.

## Why a recorder before a sniper

Every sniping tool on the market is a fast hand with no eyes. It buys the card
you picked at the price you guessed, and the guess normally comes from FUTBIN —
players submitting prices by hand, always a little behind, with nothing at all
about how many are listed or how fast they sell.

Meanwhile the listings streaming through your own client are a free, continuous
sample of the real market, and every existing tool throws them away after asking
"is this under my buy price?". Kept, they answer the question that actually
decides a trade: *is this card worth sniping at all, and at what price.*

The recorder has to go in first because history can only be collected forwards.
A sniper built later can read a month of data; a sniper built first leaves you a
month from now with nothing to aim with.

## Install

No build step — it loads as-is, so you can edit a file and hit reload.

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Open the FC web app. A small panel appears bottom-right.

Run a few market searches. The panel fills in as it sees them.

## What it sends

Nothing. There is no server, no account and no telemetry in this milestone.

Two things worth checking yourself rather than taking on trust:

- `manifest.json` declares no `host_permissions` at all. The extension cannot
  make a request to ea.com or anywhere else.
- `src/main/adapter.js` has one function, `trimAuction`, that decides what
  leaves the page. It copies price, rating, expiry and ids. The session token,
  your club and your trade history are never read.

Data lives in the extension's own IndexedDB, so clearing ea.com's site data
doesn't wipe your history. `unlimitedStorage` is requested because months of
market history is the whole point.

## How it is put together

```
src/main/adapter.js   MAIN world. The only file that knows EA's internals.
                      Passively reads market responses, posts a trimmed copy out.
src/content.js        Isolated world. Batches sightings, drives the panel.
src/background.js     Service worker. Owns the database. No loops, no timers.
src/store/db.js       IndexedDB. One row per auction, first seen and last seen.
src/model/prices.js   Floor, median, sell-through, margin after EA's 5% cut.
src/ui/panel.js       The readout, in a shadow root so EA's CSS can't reach it.
```

Two rules that shape the whole thing:

**Observe at the network layer, act through the app.** Reading is done by
patching `XMLHttpRequest` and `fetch` — passive, adds zero requests, and the
UTAS market path has outlived many bundle rewrites. When automation arrives it
will drive the web app's own controls instead of forging requests, so what EA
receives is the app's own traffic.

**Everything EA-specific lives in one file.** `adapter.js` is the seam. When a
patch changes the market payload, the panel turns amber and says so instead of
silently recording nothing — which is how every tool in this space actually
breaks, with the user finding out by losing coins.

**The service worker owns no loops.** MV3 kills it after ~30s idle. Several
competing extensions put their sniping loop there and quietly stop working
after half a minute.

## Honest limits

- **Sell-through is an estimate.** We can't see a sale. We infer one when an
  auction stops appearing well before its own expiry. It can also stop appearing
  because you stopped searching for it. The code only judges auctions whose
  ending fell inside a window you were actually watching, and reports nothing
  below a sample of 5 — but treat the number as a way to compare two cards, not
  as a true rate.
- **It only knows what you searched.** This is a record of your market, not the
  market.
- **The first days are thin.** Percentiles over a handful of listings are noise.
  It gets useful at somewhere around a few hundred sightings per card.

## Risk

EA's rules name auto-buyers as prohibited, and the penalties ladder from a
market cooldown up to a franchise ban that carries between titles. Nothing in
this milestone automates anything, so nothing here breaks that rule — but the
plan is to build automation on top of it, and that does. Worth knowing before
the next milestone, not after.

## Tests

```
npm test
```

Covers the price model, which is the part where being wrong costs coins.
