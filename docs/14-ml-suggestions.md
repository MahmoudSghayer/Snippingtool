# 14 — Market intelligence and suggestions

Scope for the suggestion engine: ingest the wider Ultimate Team market,
learn what moves player prices, and surface buy/sell suggestions with an
honest hit rate attached. Plus the global chat that carries filter sharing
between users.

This is a **scoping document, not an implementation record** — nothing here
is built yet. It exists so the sequencing and the data model get argued
about before code, because the expensive mistakes in this feature are all
made in the first two weeks (entity resolution, what gets stored, what
"correct" means) and are painful to undo later.

See [`01-architecture.md`](./01-architecture.md) for the system this plugs
into, [`08-analytics.md`](./08-analytics.md) for the existing rollups, and
[`13-roadmap.md`](./13-roadmap.md) for the phases that preceded this.

## Contents

1. [What this is, and what it is not](#1-what-this-is-and-what-it-is-not)
2. [What already exists](#2-what-already-exists)
3. [Four problems, not one](#3-four-problems-not-one)
4. [Data sources](#4-data-sources)
5. [Entity resolution — the unglamorous blocker](#5-entity-resolution--the-unglamorous-blocker)
6. [Data model](#6-data-model)
7. [Collectors](#7-collectors)
8. [Models](#8-models)
9. [Honest evaluation](#9-honest-evaluation)
10. [Surfacing it](#10-surfacing-it)
11. [Global chat and filter sharing](#11-global-chat-and-filter-sharing)
12. [Privacy and consent](#12-privacy-and-consent)
13. [Phasing](#13-phasing)
14. [Risks](#14-risks)

---

## 1. What this is, and what it is not

**It is** a signal system: it watches the market and the announcements that
move it, and tells a user "this card looks likely to fall before the weekend,
here is why, and suggestions of this kind have been right 61% of the time
over the last 90 days."

**It is not** an oracle, and the product must not read like one. The
difference is not a disclaimer in the footer — it is that every suggestion
carries a measured hit rate computed from its own past predictions (§9), and
that a suggestion type which cannot beat a naive baseline is not shipped at
all. Without that, there is no way to tell a working model from a broken
one, and no way for a user to size a position sensibly.

This framing is also what keeps the feature a trading _tool_ rather than
something that presents as financial advice.

## 2. What already exists

Verified against the running stack, not assumed:

| Thing                             | Where                                           | Use here                                                                                                                             |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sniping_activity`                | Postgres, monthly partitions                    | `resource_id`, `target_price`, **`listed_price`**, `outcome`, `latency_ms`, `occurred_at`; indexed `(resource_id, occurred_at DESC)` |
| `filter_stats`                    | Postgres                                        | realised coins/hour per filter per rolling window                                                                                    |
| `saved_filters`                   | Postgres                                        | the shareable unit for chat (§11)                                                                                                    |
| `analytics_daily`, profits rollup | Postgres, `lib/analytics/rollup.ts`             | existing daily aggregation pattern to copy                                                                                           |
| WS gateway with channel router    | `modules/ws`                                    | per-user + admin channels today; chat needs a new channel kind                                                                       |
| Bans + moderation tables          | `modules/bans`, migration `0019_moderation.sql` | chat moderation gets a head start                                                                                                    |
| `telemetryOptOut` user setting    | `modules/settings`                              | the natural place to extend for observation pooling (§12)                                                                            |

`sniping_activity` is the interesting one. It is already a cross-user,
timestamped record of **observed listing prices and real outcomes** — not
community-reported estimates. Once there is a user base, it is a better
answer to "what is actually trading right now" than any third-party site,
because it is ground truth rather than a crowd-sourced guess.

### The gap

The extension records every auction sighting into **browser-local
IndexedDB** (`apps/extension/src/store/db.ts`, object store `auctions`) and
**nothing uploads it**. `lib/api.ts` and `background/telemetry.ts` contain no
reference to observations.

So the server sees only the attempts the bot _made_, never the market it
_saw_ — a tiny, heavily biased slice. Closing this is Phase F, deferred on
purpose: with no user base it would collect nothing, which is exactly why
third-party sources come first.

## 3. Four problems, not one

"The ML engine" is four products with very different difficulty, and
conflating them is how this becomes a year-long project that ships nothing.

| #   | Problem                | Question                                     | Difficulty | Needs ML?                 |
| --- | ---------------------- | -------------------------------------------- | ---------- | ------------------------- |
| 1   | **Liquidity / volume** | Which players are moving a lot right now?    | Low        | No — aggregation          |
| 2   | **Price forecasting**  | Where does this card go over 6/24/72h?       | Medium     | Yes, after enough history |
| 3   | **Event impact**       | Promo lands Friday — how far does this fall? | Medium     | Yes, needs several cycles |
| 4   | **News → nerf/buff**   | Does this announcement move this player?     | High       | Yes, LLM extraction       |

Ship them in that order. #1 is useful on day one with no model at all, and
it is what generates the history #2 and #3 need. #4 is the flashiest and the
easiest to fake convincingly, so it goes last and stays human-reviewed
longest.

The single most important domain fact for #3: **FUT prices are
overwhelmingly supply-driven by content releases**, and the content calendar
is announced in advance. A model that knows "a promo drops Friday 6pm UK and
historically the affected rating band falls 12–18% within 36 hours" will beat
a sophisticated price-only time-series model that doesn't. Calendar first,
cleverness second.

## 4. Data sources

Decision (recorded): **third-party first**, because there is no first-party
data yet; blend in own data once it is worth analysing; follow EA's official
channels throughout.

### 4a. Price and player database

| Source     | Gives                                                        | Notes                                                |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| **FUTBIN** | Lowest BIN, price graphs, full player DB, SBC/evolution data | Largest coverage; the primary price source           |
| **FUT.GG** | Prices, player DB, meta ratings, evolution data              | Good secondary; differs enough to cross-check FUTBIN |
| **FUTWIZ** | Prices, player DB, SBC solutions                             | Third opinion; useful for detecting a bad scrape     |

Two independent price sources is not redundancy, it is the **only cheap way
to detect that a collector has silently broken** — a parser that starts
returning stale or zero prices looks exactly like a quiet market until you
have something to compare against.

Prices must be stored **per platform** (console vs PC diverge materially).
This is a dimension in the schema from day one, not a later migration.

### 4b. EA official — the highest-signal source

This is the answer to the nerf/buff question, and it is public and
structured:

| Source                               | Gives                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| **EA Pitch Notes / Title Updates**   | **The literal nerf/buff record** — gameplay changes, AI behaviour, playstyle tweaks |
| **EA FC news / content calendar**    | Promo announcements, event start/end, SBC and objective releases                    |
| **In-client FUT web app news**       | Content drops, sometimes earlier than the website                                   |
| **EA Ratings refresh announcements** | Upgrades/downgrades that reprice whole cohorts                                      |

A Title Update that nerfs a playstyle reprices _every card with that
playstyle_ — the effect is cohort-wide, not per-player, which is why §6's
signal model attaches to a **cohort predicate** as well as to individual
players.

### 4c. Community and leak sources

Lower reliability, earlier signal. Always weighted below official sources,
and always with source reputation tracked over time:

- **FUT Sheriff**, **FUT Scoreboard** (X/Twitter) — leaks, often hours to days ahead of EA
- **r/EASportsFC**, **r/fut** (Reddit API) — sentiment, event reaction, early complaint signal
- **Community Discords** — fastest, noisiest, hardest to ingest cleanly
- **YouTube trading channels** (transcripts via captions) — a large trading channel recommending a card _is itself a price event_
- **Google Trends** for player names — a genuinely useful demand proxy, free, and an honest leading indicator of hype

That YouTube point deserves emphasis: for #4, a big creator's video is often
not a _prediction_ of a price move, it is the _cause_ of one. Treating
creator activity as a feature rather than as commentary is likely to be one
of the higher-value signals available.

### 4d. First-party (the endgame)

Once there are users: upload the extension's observation store (§2's gap),
anonymised and pooled (§12). This eventually becomes the best source in the
list, and the one no competitor can copy.

### 4e. Collector conduct

Collectors are built to be **polite, not evasive**:

- One shared fetch layer with per-source rate limits, conservative
  concurrency, and exponential backoff on 429/5xx.
- Identifiable User-Agent with a contact URL. Honour `robots.txt` and
  `Retry-After`.
- Aggressive caching and conditional requests (`ETag`/`If-Modified-Since`);
  never re-fetch a page whose content hash has not changed.
- Poll rates matched to how fast the data actually changes — player metadata
  is near-static, prices are not.

**If a source blocks us, the answer is to back off and seek permitted
access, not to escalate.** An evasion arms race is unbounded maintenance
that fails silently and takes the product's core feature down with it. The
adapter boundary in §7 exists so a source can be dropped or swapped without
touching anything downstream.

**ToS position, recorded so the call stays informed:** FUTBIN, FUT.GG and
FUTWIZ all prohibit automated collection in their terms. Scraping public
pages is not the same as unauthorised access, but it is a terms breach and
carries a real risk of IP blocking and a small one of a legal complaint. The
decision to proceed was taken deliberately, with the cold-start problem as
the reason. Revisit it once first-party data can carry the product (Phase F),
since the dependency is the thing worth removing regardless of the legal
question.

## 5. Entity resolution — the unglamorous blocker

Every source names players differently:

- EA uses `resourceId` (an integer encoding player + card version)
- FUTBIN and FUT.GG use their own internal ids and URL slugs
- News and leaks use **human names** ("TOTY Mbappé", "the 91 Haaland")

Nothing works until these resolve to one canonical card. A price series that
silently mixes two card versions of the same player is worse than no series,
because it looks plausible.

This is the piece most likely to be underestimated. It needs:

- A `players` / `cards` canonical table keyed on EA `resourceId`
- A `card_source_ids` mapping table (one row per source per card)
- Fuzzy name + rating + club/nation matching for news text, with a
  confidence score and a **human review queue** for anything below threshold
- Re-resolution each FC title, and each time a source changes its id scheme

Budget real time for this. It is the foundation for all four problems.

## 6. Data model

New tables, following existing conventions (uuid v7 ids, `created_at`,
soft-delete where user-facing, BRIN + partitioning for time series as
`sniping_activity` already does):

**Reference**

- `cards` — canonical card identity: `resource_id`, name, rating, position, club, league, nation, card version, FC title
- `card_source_ids` — `card_id`, `source`, `external_id`, `url`, `confidence`

**Time series** (partitioned by month, like `sniping_activity`)

- `price_observations` — `card_id`, `source`, **`platform`**, `price_kind` (lowest BIN / range min / range max), `price`, `observed_at`
- `market_volume` — `card_id`, `platform`, window, observed listing count / churn proxy

**Calendar and news**

- `market_events` — promo/SBC/objective/ratings-refresh: `kind`, `title`, `starts_at`, `ends_at`, `source_url`, `confidence` (announced vs leaked)
- `news_items` — `source`, `url`, `published_at`, `title`, `body`, `content_hash` (dedupe across sources)
- `news_signals` — extracted from a `news_item`: `direction` (up/down), `magnitude_bucket`, `confidence`, and a target that is **either** a `card_id` **or** a `cohort_predicate` (JSON: e.g. playstyle, rating band, league) — per §4b, nerfs hit cohorts

**Predictions and accountability**

- `price_forecasts` — `card_id`, `platform`, `horizon_hours`, `predicted_direction`, `predicted_pct`, `confidence`, `model_version`, `made_at`
- `suggestions` — the user-facing object: `card_id`, `kind` (buy/sell/hold-off), `rationale` (structured, not prose), `expected_move`, `confidence`, `expires_at`
- `suggestion_outcomes` — realised move at each horizon, joined back for hit rate (§9)

`suggestion_outcomes` is not optional bookkeeping. It is the table that makes
§1's honesty claim true, and it must be written by a scheduled job whether or
not anyone is looking at the numbers.

## 7. Collectors

A worker-side collector framework (the `worker` service already exists and
runs BullMQ):

```
packages/collectors/
  src/
    framework/        fetch layer: rate limit, cache, backoff, robots, hashing
    sources/
      futbin/         prices + player DB adapters
      futgg/
      futwiz/
      ea-news/        content calendar + promo announcements
      ea-pitch-notes/ title updates -> nerf/buff signals
      reddit/
      x/              FUT Sheriff, FUT Scoreboard
      youtube/        captions for trading channels
      google-trends/
```

Each adapter exposes the same shape — `fetch() → RawDocument[]` and
`parse(raw) → typed rows` — so a source can break, be disabled by a feature
toggle (`modules/admin-toggles` already exists), and leave the rest running.
Raw documents are stored before parsing, so a parser bug is replayable
without re-hitting the source.

Collector health (last success, parse failure rate, cross-source price
divergence) is a first-class dashboard: a silently broken collector is the
most likely failure mode in this whole feature.

## 8. Models

**#1 Liquidity / volume.** SQL over `price_observations` + `market_volume`:
biggest movers, unusual churn, price-vs-7-day-median. No model. Ships first,
and is the thing users will probably use most.

**#2 Price forecasting.** Start with baselines — last value, seasonal naive
(same hour yesterday / last week), EWMA — and _record their accuracy_. Any
learned model must beat them or it does not ship. Then one **global**
gradient-boosted model over all cards with card attributes as features
(rating, league, position, playstyles, card version, days since release),
not per-card models, which will not scale and will overfit thin series.

**#3 Event impact.** Around each `market_events` row, measure the realised
move per cohort versus a matched control cohort — difference-in-differences.
After a handful of promo cycles this gives defensible statements like "83-rated
gold rares in this league historically fall 14% ± 5% in the 36h after a promo
of this kind." Honest and genuinely actionable. Needs several cycles before it
says anything; do not ship it early with one data point.

**#4 News → signal.** LLM extraction over `news_items` into structured
`news_signals` (see [`claude-api`](https://docs.claude.com/en/api) usage
elsewhere in this repo). Output is strictly structured — direction, magnitude
bucket, target card or cohort, confidence — never free prose presented as a
prediction. **Human review queue before any signal reaches users** until
measured precision justifies loosening that, and source reputation weights
learned from realised outcomes.

## 9. Honest evaluation

Non-negotiable, and built before the first model rather than after:

- **Walk-forward backtesting only.** No random train/test split on a time
  series — it leaks the future and makes everything look brilliant.
- **Baselines first.** "Price stays flat" and "follow the 7-day trend" are
  the bar. A model that cannot beat both is not shipped.
- **Per-suggestion-type hit rate**, computed from `suggestion_outcomes` over
  a rolling window, **displayed next to the suggestion in the UI**.
- **Calibration, not just accuracy.** When the engine says 70% confident, it
  should be right about 70% of the time. Track a reliability curve; a
  confidently wrong model is worse than no model.
- **A kill switch per suggestion type**, reusing the existing
  `admin-toggles`, so a decaying model can be pulled without a deploy.

## 10. Surfacing it

Extends the `/bot` page added in the Bot commit, rather than a new silo:

- **Market tab** — biggest movers, unusual volume, watchlist (problem #1)
- **Events timeline** — upcoming promos/SBCs from `market_events`, with the
  historical cohort impact from #3 attached
- **Suggestions** — cards with rationale, expected move, confidence and hit
  rate; one click to turn a suggestion into a saved filter, which is the
  natural bridge back to the bot
- **Per-card detail** — price history across sources and platforms, related
  news, past forecasts vs what actually happened (visible accountability)

Prior art in-repo: the Analytics "Filter performance" tab is the pattern for
charts + tables over a rolling window.

## 11. Global chat and filter sharing

Independent of the ML work — different system, different risks, can be built
in parallel or first.

**Substrate.** `modules/ws` already has a channel router with per-user and
admin channels; chat adds a `chat:<room>` channel kind. Rooms start as a
single global room plus, later, topic rooms.

**Filter sharing is the point.** A saved filter is a small JSON blob with
existing CRUD, so "share to chat" posts a structured message that renders as
a filter card with a one-click import (`POST /api/v1/filters`). This is the
feature that makes the chat worth having rather than a generic room.

**Cost is moderation, not sockets.** Budget for it up front:

- `chat_messages` with retention, `chat_reports`, mutes reusing `modules/bans`
- Rate limiting and slow mode (the rate-limit tiers already exist)
- Link handling — FUT communities attract coin-selling and account-phishing
  scams; unrestricted link posting in a trading chat is a known vector
- Admin moderation view alongside the existing `/admin` pages

**Imported filters are untrusted input.** A shared filter is data from
another user: validate it against `filterCriteriaSchema` on import exactly as
the API already does, and never render its name as anything but text.

## 12. Privacy and consent

Decision (recorded): **opt-out, anonymised.**

- Observations are pooled by default; the existing `telemetryOptOut` setting
  is extended to cover market-observation contribution, with its own clear
  copy — a user opting out of crash telemetry has not necessarily opted out
  of contributing market data, and conflating them silently is the kind of
  thing that is indefensible later.
- **De-identify before aggregation, not at query time.** Pooled market data
  carries `card_id`, price, platform and timestamp — never `user_id`,
  `device_id` or filter identity. A market price observed by a user is not
  personal data once stripped; a user's _search pattern_ is, and must not
  leak into the pool.
- Beware re-identification via thin slices: an observation on an obscure card
  at an odd hour can identify a single contributor. Apply a minimum
  contributor threshold before a pooled aggregate is exposed.
- Document this in the privacy policy before the first pooled aggregate ships.

## 13. Phasing

Each phase is independently useful — none is a big-bang prerequisite for
shipping something a user notices.

| Phase    | What                                                                      | Exit criteria                                                                       |
| -------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **A**    | Entity resolution (§5) + collector framework + FUTBIN/FUT.GG price ingest | Two sources agreeing within tolerance on a sampled card set; health dashboard green |
| **B**    | Market tab: movers, volume, watchlist (problem #1)                        | Useful to a user with zero models involved                                          |
| **C**    | EA news + Pitch Notes + content calendar → `market_events`                | Upcoming events visible with historical cohort impact                               |
| **D**    | News/leak extraction → `news_signals`, human-reviewed                     | Measured precision on a labelled sample; review queue working                       |
| **E**    | Forecasting + event impact + backtest harness + hit-rate display          | Beats both baselines on walk-forward; calibration curve sane                        |
| **F**    | First-party observation upload, anonymised pooling, blend into models     | Own data measurably improves accuracy over third-party alone                        |
| **Chat** | Global room, filter sharing, moderation                                   | Can run in parallel with any of the above                                           |

Phase A is the one to resist rushing. Everything downstream inherits its
mistakes.

## 14. Risks

- **Source blocking or ToS escalation** (§4e). Mitigated by polite
  collectors, multiple sources, adapter isolation and feature toggles — and
  ultimately by Phase F removing the dependency.
- **Silent collector rot.** A parser that returns stale data looks like a
  quiet market. Mitigated by cross-source divergence alarms, not by hoping.
- **Entity resolution drift.** Each FC title and each source redesign
  breaks mappings. Needs owned, scheduled re-resolution.
- **Cold start.** Problems #2 and #3 need months of history and several promo
  cycles. Shipping them early with thin data produces confident nonsense; the
  phasing exists to stop that.
- **Overfitting to one promo cycle.** Events differ (promo vs SBC vs ratings
  refresh). Hold out whole events, not random rows.
- **Reflexivity — the interesting one.** With enough users acting on the same
  suggestion, the suggestion _moves the market_: first self-fulfilling, then
  self-defeating as everyone buys into the same card and the BIN rises. At
  scale this feature is a participant, not an observer. Watch for it by
  measuring whether realised moves on suggested cards degrade as user count
  grows, and consider staggering or rate-limiting identical suggestions.
- **The product looking more certain than it is.** The mitigation is §9,
  enforced — not a disclaimer.
