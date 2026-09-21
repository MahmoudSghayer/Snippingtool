# 10 — Design system

Status: implementation-ready, applied. Covers `packages/ui` (the design
system) and its application across `apps/dashboard` (every page + shell).
This is the PHASE 10 deliverable: brand + tokens + component inventory +
motion + accessibility + page-by-page spec, plus the record of what this
pass changed and verified. Read [`07-dashboard.md`](./07-dashboard.md) for
the dashboard's information architecture, routing and data flow —
this document is about *how it looks and behaves*, that one is about *how
it's built*.

## Contents

1. [Brand principles](#1-brand-principles)
2. [Color tokens](#2-color-tokens)
3. [Typography](#3-typography)
4. [Spacing, radius, elevation](#4-spacing-radius-elevation)
5. [Motion](#5-motion)
6. [Iconography](#6-iconography)
7. [Component inventory](#7-component-inventory)
8. [Chart guidelines](#8-chart-guidelines)
9. [Layout grid + breakpoints](#9-layout-grid--breakpoints)
10. [Accessibility checklist](#10-accessibility-checklist)
11. [Page-by-page spec](#11-page-by-page-spec)
12. [Performance](#12-performance)
13. [What this pass changed](#13-what-this-pass-changed)
14. [Known gaps / follow-ups](#14-known-gaps--follow-ups)

---

## 1. Brand principles

The Sniper's Ledger reads as a **companion app for a live trading loop**,
not a generic SaaS admin panel. Four principles drive every design
decision:

1. **Dense, not cramped.** A sniper is watching numbers move; the UI
   favours information density (compact stat tiles, tight table rows,
   small type for secondary data) over whitespace-heavy marketing-site
   spacing — but every dense surface still keeps an 8px rhythm and never
   touches text to a border.
2. **Numbers are the product.** Every coin figure, percentage, rate and
   count is set in **JetBrains Mono with `tabular-nums`**, so values stay
   vertically aligned in a column and a delta reads at a glance without
   re-parsing digit widths.
3. **Color carries meaning, consistently.** Gold is money/accent (the
   sniper's namesake asset). Green is positive/live/profit. Red is
   negative/risk. These three never swap roles anywhere in the product —
   dashboard, popup, options page or panel. A status is never color alone:
   every colored state ships with an icon and/or text label next to it.
4. **Fast and quiet.** Motion is short (150–250ms) and only ever confirms
   an action or eases a transition — nothing loops, nothing calls
   attention to itself while the trader's eyes are on the market page in
   another tab. `prefers-reduced-motion` is honoured globally, not
   per-component.

## 2. Color tokens

Dark theme only (`color-scheme: dark`); source of truth is
`packages/ui/src/tokens.css`, mapped into Tailwind v4's `@theme` by
`apps/dashboard/src/styles/global.css`.

### Surfaces & ink (text/UI roles — tuned for small-text contrast)

| Token | Hex | Tailwind | Role | Contrast |
|---|---|---|---|---|
| `--sl-ground` | `#0d1311` | `bg-ground` | Page background | — |
| `--sl-surface` | `#151d1a` | `bg-surface` | Card/sidebar background | — |
| `--sl-surface-2` | `#1b2522` | `bg-surface-2` | Raised surface (dropdown, input, table header) | — |
| `--sl-line` | `#242f2b` | `border-line` | Borders/dividers | — |
| `--sl-ink` | `#e7edea` | `text-ink` | Primary text | 15.83:1 vs ground, 14.48:1 vs surface — AAA |
| `--sl-ink-2` | `#94a49e` | `text-ink-2` | Secondary/muted text | 7.21:1 vs ground, 6.60:1 vs surface — AAA |
| `--sl-gold` | `#ddb35c` | `bg-gold` / `text-gold` | Accent, money, primary buttons | 9.55:1 vs ground, 8.00:1 vs surface-2 — AAA |
| `--sl-green` | `#6fbf9b` | `bg-live` / `text-live` | Positive/live/profit status, badges | 8.59:1 vs ground, 7.20:1 vs surface-2 — AAA |
| `--sl-red` | `#e08678` | `bg-risk` / `text-risk` | Negative/risk status, badges | 7.02:1 vs ground, 5.88:1 vs surface-2 — AA+ |
| `--sl-mid` | `#d6a94e` | `text-risk-mid` | Warning midpoint | — |

All body-text and status-badge contrast ratios above were computed against
every surface they're actually painted on (ground/surface/surface-2) and
clear **WCAG AA (4.5:1)** for normal text with margin to spare — most clear
AAA (7:1). `--sl-gold-ink`/`--sl-accent-ink` (`#221a0b`) is the *dark* text
color used *on top of* a solid gold button/badge fill, not gold text on
dark — that pairing is checked separately per component (Button primary:
`#221a0b` on `#ddb35c` = 11.7:1).

### Chart series palette (marks only — a separate, more-saturated ramp)

`--sl-chart-1..6` back every multi-series chart (`packages/ui/src/charts/*`,
read at call time via `seriesColor()`). This is deliberately **not** the
same hex as the status tokens above: marks only need **3:1** contrast
against the chart surface (WCAG 1.4.11, non-text UI components), so they
sit at a chroma/lightness tuned to read clearly as fills and lines rather
than at the higher-contrast band small text needs. Validated with the
`dataviz` skill's palette validator against this app's actual dark surfaces:

```
node scripts/validate_palette.js \
  "#35a87e,#b96fd9,#d9584a,#2fa8ad,#b9822a,#4f7fd9" \
  --mode dark --surface "#151d1a"
→ ALL CHECKS PASS (lightness band, chroma floor, adjacent CVD ΔE, normal-vision floor, contrast)
```

| Slot | Hex | Role |
|---|---|---|
| `--sl-chart-1` | `#35a87e` | green — "positive" series (also `POSITIVE_COLOR`) |
| `--sl-chart-2` | `#b96fd9` | purple |
| `--sl-chart-3` | `#d9584a` | red — "negative" series (also `NEGATIVE_COLOR`) |
| `--sl-chart-4` | `#2fa8ad` | teal |
| `--sl-chart-5` | `#b9822a` | gold |
| `--sl-chart-6` | `#4f7fd9` | blue |

**Order is the CVD-safety mechanism, not cosmetic** — slots 2/6
(purple/blue) and 3/5 (red/gold) are deliberately non-adjacent because
those pairs fail the protan/normal-vision separation floor when next to
each other. Do not reorder without re-running the validator.
`POSITIVE_COLOR`/`NEGATIVE_COLOR` (`charts/palette.ts`) are pinned directly
to the green/red hex, not resolved by array index, so a future reorder of
the ramp can never silently flip a profit/loss chart's polarity. The
previous palette (`#6fbf9b,#ddb35c,#7ea7e0,#c993dd,#e08678,#8fd0c9` — the
status colors reused as chart marks) **failed** this validator: it was
below the chroma floor on 3 of 6 slots, outside the dark lightness band on
all 6, and its purple/blue pair scored ΔE 2.2 protan / 11.1 normal-vision
(both hard fails). Status colors and chart-mark colors are now two
intentionally different ramps sharing the same 3 brand hues (green/gold/
red) at different roles — that split is itself documented in
`palette.ts`'s header comment so a future edit doesn't "fix" it back into
one array.

### Sequential / diverging

No sequential ramp or diverging pair is in use yet — every current chart is
categorical (series-by-entity) or a simple 2-state positive/negative area
(green/red directly, not a ramp). If a heatmap or choropleth is added
later, derive a single-hue sequential ramp from the gold or green hue
following the `dataviz` skill's `color-formula.md`, and validate it the
same way.

## 3. Typography

- **Inter** — UI text (headings, body, labels, buttons). Loaded via Google
  Fonts (`index.html`), weights 400/500/600/700.
- **JetBrains Mono** — every number: coins, percentages, dates in tables,
  license keys, IDs. Weights 400/500/600. `.tabular-nums` /
  `input[type=number]` get `font-variant-numeric: tabular-nums` globally
  (`global.css`) so digit columns never jitter.

| Role | Class | Size / weight |
|---|---|---|
| Page title (`PageHeader`) | `text-xl font-semibold` | 20px / 600 |
| Card title | `text-base font-semibold` | 16px / 600 |
| Body | `text-sm` | 14px / 400 |
| Secondary / muted | `text-sm text-ink-2` | 14px / 400, `--sl-ink-2` |
| Label / eyebrow (StatTile label, table header) | `text-xs font-medium uppercase tracking-wide` | 12px / 500 |
| KPI value (StatTile) | `font-mono text-2xl font-semibold tabular-nums` | 24px / 600 |
| Table cell (numeric) | `font-mono tabular-nums` | 14px / 400 |
| Micro (badges, kbd hints) | `text-xs` | 12px |

## 4. Spacing, radius, elevation

- **Spacing** follows Tailwind's default 4px scale; the app's own rhythm is
  `gap-4`/`gap-6` between cards and sections, `px-5 py-4` inside card
  headers, `px-4 py-2.5`–`px-4 py-3` inside table cells (dense, per brand
  principle 1), `px-4 sm:px-6` for page/topbar horizontal padding (tighter
  on mobile).
- **Radius**: `--sl-radius-sm` 6px (buttons sm, badges' inner elements,
  inputs), `--sl-radius-md` 10px (buttons md/lg, modals), `--sl-radius-lg`
  14px (cards, tables, the command palette).
- **Elevation** is border + shadow, not a blur/opacity stack: `border
  border-line` on every raised surface, `shadow-xl`/`shadow-2xl` only on
  floating layers (dropdowns, tooltips, modals, drawers, the command
  palette, toasts) — cards and tables sit flush on the page with a border
  only, keeping the dense layout calm.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--sl-motion-fast` | 150ms | Hover/active state changes (button brightness, row hover) |
| `--sl-motion-base` | 200ms | Default transition duration |
| `--sl-motion-slow` | 250ms | Modal/drawer/palette open-close, toast enter |
| `--sl-ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | Standard ease for all of the above |

All zeroed under `@media (prefers-reduced-motion: reduce)`
(`tokens.css`), which also forces every CSS animation/transition
`duration` to `0.01ms` and `scroll-behavior: auto` as a global fallback —
individual components never need their own reduced-motion check. Radix's
built-in open/close data-state animations (Modal, Drawer, Dropdown,
Command palette) inherit this the same way, since they're plain CSS
`animate-in`/`animate-out` utility classes.

## 6. Iconography

`lucide-react` exclusively, `size-4` (16px) default in-line with text,
`size-5`/`size-6` for standalone/empty-state icons. Every icon that's
purely decorative (paired with adjacent text) gets `aria-hidden="true"`;
an icon-only control (`IconButton`, the mobile hamburger, close buttons)
gets `aria-label` instead. The app mark (`apps/dashboard/public/favicon.svg`)
is a gold scope-reticle on the ground color with a green center dot — a
sniping motif distinct from, but in the same palette as, the `Shield`
brand glyph used in the sidebar/login header.

## 7. Component inventory

All in `packages/ui/src/components/**` + `charts/**`, re-exported from
`@sl/ui`'s root. Anatomy/states/do-don't for the ones with the most
surface area — the rest follow the same tokens and are simpler variations.

### Button

- **Variants**: `primary` (gold fill, `--sl-accent-ink` text — the one
  call-to-action per view), `secondary` (surface-2 fill + border),
  `outline` (transparent + border), `ghost` (transparent, no border),
  `destructive` (red fill, for irreversible actions — ban, revoke, delete).
- **Sizes**: `sm` (32px), `md` (40px, default), `lg` (48px).
- **States**: hover (`brightness-110`), active (`brightness-95`), disabled
  (`opacity-50` + `cursor-not-allowed`), loading (spinner replaces
  `leftIcon`, `aria-busy`, still disabled to prevent double-submit),
  `focus-visible` (2px gold ring, 2px offset, on every variant).
- **Do**: one `primary` button per view/card. Use `destructive` only for an
  action a `ReasonDialog`/confirmation already gated.
- **Don't**: stack two `primary` buttons side by side — pair `primary` +
  `outline`/`ghost` instead.

### Card / ChartCard / StatTile

- `Card` is the base surface (`bg-surface border-line rounded-lg`);
  `CardHeader`/`CardTitle`/`CardDescription`/`CardContent` compose inside
  it.
- `ChartCard` wraps a chart with a fixed-height body (`height`, default
  280px — **reserved before data arrives**, so a chart never shifts layout
  on load), a title/description/actions header, an optional `legend` row
  (see §8), and built-in loading (`Skeleton`) / empty (`EmptyState`)
  states driven by `isLoading`/`isEmpty` — no chart-owning page hand-rolls
  these.
- `StatTile`: label (uppercase eyebrow) + `font-mono` value + optional
  delta (arrow + signed percent, green/red by `invertDeltaTone`) +
  optional `sparkline` slot. A status is never color-alone here either —
  the arrow direction is independent of the delta's color, so a
  colorblind reader still gets the trend from the glyph.

### StatTile "Do / Don't"

- **Do** pair a delta with a comparison period (`deltaLabel`, e.g. "vs
  prior 7d") — a bare percentage with no anchor is meaningless.
- **Don't** use `invertDeltaTone` for anything but genuinely inverted
  metrics (error rate, churn) — for money, more is good, non-inverted.

### DataTable

- TanStack Table under a styled `<table>`. Sortable columns get a
  click-to-cycle header button with an `ArrowUp`/`ArrowDown`/`ArrowUpDown`
  glyph (never color-only sort indication). **Sticky header** (`thead`
  `sticky top-0 z-10`, `bg-surface-2`) inside a `max-h-[70vh]
  overflow-auto` scroll region — long tables (users, audit log, activity)
  keep their column headers on screen while the body scrolls, rather than
  scrolling the header off with the page. Built-in states: loading
  (skeleton rows, count via `skeletonRows`), error (`EmptyState` + Retry
  button, in the body so column headers stay visible), empty (`EmptyState`
  with `Inbox` icon), and cursor pagination (`Previous`/`Next`, disabled at
  the ends). `enableColumnVisibility` adds a `DropdownMenu` "Columns"
  toggle for wide admin tables.
- **Density**: `px-4 py-2.5` header cells, `px-4 py-3` body cells — dense
  by brand principle 1, never so tight that a click target drops under the
  44px/32px informal touch-target floor (row height ≈ 44px with `text-sm`
  content).
- **Do** pass `getRowId` for any table backed by server data (stable React
  keys across refetch/sort).
- **Don't** put more than ~2 pieces of information per numeric column
  header — the header row is one line, `whitespace-nowrap`.

### ChartLegend (new this pass)

- A plain, static `<ul>` of colored-dot + label pairs, rendered by
  `ChartCard`'s `legend` slot. **Always present for ≥2 series, never
  rendered for exactly 1** (`items.length < 2` short-circuits to `null`) —
  identity is never color-alone on a multi-series chart, and a single-line
  chart doesn't need a legend box repeating its own title. Deliberately
  separate from Recharts' own `<Legend>` (which re-renders on hover/paint
  order) so it's a stable, keyboard-reachable-by-tab-order-free static row.
  Built via `seriesLegendItems(series)`, which resolves each series'
  `colorIndex` through the same `seriesColor()` every chart mark uses, so
  a legend dot and its line/bar are guaranteed the same hex.

### CommandPalette (new this pass)

- `packages/ui`'s `CommandPalette` is the presentational primitive
  (query input, keyboard-navigable `listbox`, `Esc`-to-close via Radix);
  `apps/dashboard/src/components/CommandPalette.tsx` wires it to real data
  (the static route list + a debounced `GET /admin/users?q=` for admins).
  Opens on **Cmd/Ctrl+K** anywhere the authenticated shell is mounted
  (`useCommandPaletteShortcut`), or via the topbar's "Search" button
  (desktop) / magnifying-glass icon button (mobile, where the text hint
  is hidden for space).
- **States**: typing an admin's search re-queries after 2+ characters;
  results appear inline under the route matches, each showing
  `email` + `status · role`; selecting one navigates to `/admin/users?q=` —
  the Users page reads that as its initial search text
  (`useSearch({ from: '/app/admin/users' })`), so the deep link actually
  lands pre-filled rather than just opening the page.
- **Keyboard**: `↑`/`↓` moves `aria-selected`, `Enter` activates,
  `Escape`/overlay-click closes (Radix `Dialog`), input keeps focus
  (`autoFocus`) the whole time — never a mouse-only path to any result.

### Drawer (extended this pass)

- Now supports `side="left" | "right"` (was right-only) and an optional
  chrome-less mode (`title` omitted — a `sr-only` "Navigation" title is
  substituted so Radix's a11y requirement is still met). `side="left"
  width="nav"` is exactly the mobile off-canvas sidebar (§9); `side="right"`
  (default) is unchanged — user/audit detail panels.

### Other components (brief)

- **Badge**: 5 tones (`neutral`/`positive`/`negative`/`warning`/`accent`),
  pill shape, 15% tint fill + 30% tint border — never solid fill (reserves
  solid color for buttons/primary actions).
- **Modal**: centered, for confirmations and short forms. **Drawer**: side
  panel, for anything scrollable/wide (record detail, mobile nav).
  **Don't** put a data table inside a Modal — use a Drawer or a page.
- **Toast** (`sonner`, themed via `Toaster`): bottom-right, dark surface-2,
  colored left-border by tone (success/error/warning) — never the only
  signal for a critical error (paired with an inline `EmptyState`/error
  state on the page that triggered it).
- **Tabs, Select, Switch, Checkbox, DropdownMenu, Tooltip**: Radix
  primitives, keyboard nav and focus management included by the library;
  themed to tokens here.
- **EmptyState**: icon + title + optional description + optional action —
  the one shape every "nothing here" / "this broke" / "you don't have
  access" surface in the app uses (DataTable's empty/error rows,
  ChartCard's empty state, 404, admin-gate, dashboard's overview-fetch
  error).
- **Skeleton**: a single pulsing block primitive; every loading state
  composes it (`ChartCard`'s full-height skeleton, `DataTable`'s
  per-column skeleton rows) rather than a spinner — skeletons preserve
  layout (no shift when data arrives), spinners don't.
- **PageHeader**: title + description + `actions` slot (right-aligned,
  wraps below title on narrow screens) — every page's H1.
- **KpiGrid**: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` — the one KPI
  row layout, reused verbatim on Dashboard/Analytics/Admin Overview/
  Subscriptions.
- **Sidebar**: brand + grouped nav sections + footer; `linkComponent` is
  injected (router-agnostic) so `packages/ui` never imports the router.
- **DiffViewer, CopyField, DateRangePicker**: purpose-built for Audit log
  (before/after JSON diff), license keys/2FA secrets (copy-to-clipboard
  with a confirmed state), and every analytics page's range filter.

## 8. Chart guidelines

Every chart in this app goes through `packages/ui/src/charts/*`, which
already encode the `dataviz` skill's rules so a page author can't
accidentally violate them:

- **One axis.** No chart in the app uses a dual y-axis; two differently-scaled
  measures always get two charts (see Analytics: "Snipe outcomes" vs
  "Coins traded" as separate `ChartCard`s, not one chart with two scales).
- **Legend for ≥2 series, none for 1** — enforced in `ChartLegend` itself
  (§7), wired via `ChartCard`'s `legend` prop on every 2+-series chart:
  Analytics "Snipe outcomes" (Attempts/Successes), Admin Overview
  "Retention" (D7/D30) and "Extension versions" (donut, per-version),
  Admin Subscriptions "New vs. canceled" and "Plan mix" (donut,
  per-plan).
- **Tooltips everywhere.** One shared `ChartTooltip` (dark surface-2 card,
  colored dot + name + `tabular-nums` mono value) backs every Line/Area/
  Bar/Donut chart — hover crosshair behavior comes from Recharts'
  `<Tooltip>` itself, styled through this one component so it never drifts
  between chart types.
- **Gap-filled series.** `LineChart`/`AreaChart` default `connectNulls` to
  `true` — every series here is a rolling day/week/month bucket (never a
  sparse event log where a missing point is itself the signal), so a
  bucket with no data bridges the line instead of breaking it. Pass
  `connectNulls={false}` explicitly for a future chart where a real gap
  *is* meaningful.
- **Responsive containers, reserved heights.** Every chart wrapper is
  `<ResponsiveContainer width="100%" height="100%">` inside `ChartCard`'s
  fixed-height (`height`, default 280px) box — the container never
  measures 0×0 on first paint and the card never reflows once data
  arrives (no layout shift).
- **Palette**: see §2 — validated, ordered, marks-only ramp; `seriesColor(i)`
  is the only way any chart resolves a series color, so the ramp can be
  re-tuned once in `tokens.css` without touching a single chart component.
- **Sparkline** is the one intentional exception to "always a legend/axis/
  tooltip" — it's a trend glyph inside `StatTile`, not a standalone chart,
  and ships with no axes/grid/tooltip by design (dataviz skill: "no chart
  junk — a sparkline's only job is shape").

## 9. Layout grid + breakpoints

Tailwind v4 defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px,
`2xl` 1536px. The three breakpoints named in the brief map to:

| Viewport | Breakpoint | Shell behavior |
|---|---|---|
| 390px (mobile) | `< sm` | Sidebar **hidden**, replaced by a hamburger button (topbar, left) opening a `Drawer side="left" width="nav"` off-canvas nav (same `Sidebar` content, closes on link tap). Topbar collapses: connection dot/label and the "Admin" badge hide (`hidden sm:flex`/`sm:inline-flex`), the "Search ⌘K" button becomes an icon-only button, the user email hides (`hidden md:inline`). KPI grids go to 1 column, chart grids to 1 column, page padding tightens to `px-4`. |
| 768px (tablet) | `sm`–`lg` | Sidebar still hidden (drawer nav) below `lg` — a docked sidebar at 768px would leave too little width for a data table. KPI grids reach 2 columns (`sm:grid-cols-2`), chart grids stay 1 column until `lg`. Topbar regains the connection indicator and full "Search" button. |
| 1440px (desktop) | `≥ lg`/`xl` | Docked sidebar (`hidden lg:flex`, 256px). KPI grids reach 4 columns (`lg:grid-cols-4`), chart/analytics grids reach 2–3 columns (`lg:grid-cols-2`/`lg:grid-cols-3`), full topbar. |

Tables don't switch to a card-row layout at mobile width — the brand's
"dense, tabular" principle (§1) and the sniping-companion audience (who
routinely also use the extension popup at 360×600, an even narrower
surface than the dashboard's mobile breakpoint) favour a **horizontally
scrollable table** (`overflow-x-auto` on `DataTable`'s wrapper, already
present) over reflowing rows into cards, which would lose column alignment
for exactly the numeric data this product is about. This is a deliberate
deviation from the brief's "tables → card rows **or** pinned-column
scroll" — pinned-column/horizontal-scroll was chosen over card rows for
that reason; a true pinned first-column (sticky `left-0` on the first
`<td>`/`<th>`) is flagged in §14 as a follow-up for the widest admin
tables (Users, Audit).

## 10. Accessibility checklist

- [x] Every interactive element has a visible `:focus-visible` ring
      (2px gold, offset) — both globally (`global.css`) and per-component
      (`Button`, links, table sort headers, palette items).
- [x] Color is never the only signal: StatTile deltas pair color with an
      arrow glyph; Badges pair color with a text label; DataTable sort
      state pairs color with an arrow icon; chart legends pair color with
      a text label.
- [x] All status-text/badge tokens clear WCAG AA (4.5:1) against every
      surface they're painted on (§2 table); chart marks clear the 3:1
      non-text-UI floor.
- [x] Every icon-only control has `aria-label` (mobile hamburger, palette
      trigger, Drawer/Modal close buttons, IconButton usages); every
      decorative icon has `aria-hidden="true"`.
- [x] Loading/empty/error states exist on every data surface (ChartCard,
      DataTable, the Dashboard/Analytics/Overview page-level fetch errors)
      — nothing renders a bare blank space or throws to the error
      boundary for an expected "no data yet" or "request failed" case.
- [x] Radix primitives (Dialog, DropdownMenu, Select, Tabs, Switch,
      Checkbox, Tooltip) supply full keyboard operability and focus
      trapping out of the box — Modal/Drawer/Command palette all close on
      `Escape` and trap focus while open; DropdownMenu is arrow-key
      navigable.
- [x] Command palette is fully keyboard-operable end to end (open via
      Cmd/Ctrl+K, type, `↑`/`↓`, `Enter`, `Esc`) with no mouse-only path.
- [x] `prefers-reduced-motion: reduce` zeroes all motion tokens and forces
      every animation/transition duration to near-zero globally
      (`tokens.css`) — verified for Radix's own `animate-in`/`animate-out`
      utility classes too, since those are plain CSS animations.
- [x] Every `<img>`/SVG icon that conveys information (not just the
      favicon) ships a text alternative; the favicon/app mark has
      `role="img"` + `aria-label`.
- [x] `axe-core` (`@axe-core/playwright`) asserts **zero serious/critical**
      violations on Login, Dashboard and Admin Overview in
      `apps/dashboard/e2e/accessibility.spec.ts` (§13).
- [ ] Fine-grained per-admin-role UI gating is a known, documented gap
      (`07-dashboard.md` §2/§11) — out of scope for this pass (API doesn't
      expose the caller's own `adminRole` yet); every admin currently sees
      every admin nav item, with the server as the real enforcement point.

## 11. Page-by-page spec

Every page below shares the same shell (topbar + sidebar/drawer,
`AppLayout`) except Login/Register, which use `PublicLayout` (centered card,
brand header, no nav). Per-route `<title>` (`router.tsx`'s `PAGE_TITLES`
map + `router.subscribe('onResolved', …)`) and `<meta name="theme-color"
content="#0d1311">` are set once, globally, not per-page.

### Login (`/login`)

Centered `PublicLayout` card. Email + password (`PasswordInput`, visibility
toggle) + a required "This device" name field (device registration) →
`Sign in`. On `mfa_required`, replaces the form in place with either the
admin-bootstrap enrollment flow (QR code via `qrcode`, manual-entry secret
via `CopyField`, 10 recovery codes, 6-digit confirm) or the plain step-up
verify-code form — chosen automatically, not by the user. Error states:
inline `EmptyState`-less field-level errors (react-hook-form) for
validation, a toast for a rejected credential/lockout. Links to
`/register` and `/forgot-password`.

### Register (`/register`)

Same shell. Email + password + confirm-password (client-side `.refine()`
match check on top of the shared Zod password-policy schema) → account
created, redirected to `/verify-email` flow. Password policy is
show-as-you-type (the shared schema's rules rendered as a small checklist,
not just a rejected-submit error).

### Dashboard (`/dashboard`)

The trader's home. `PageHeader` → `KpiGrid` (Net profit 7d/30d, Snipe
success rate, Active devices) → an inline error `EmptyState` (with Retry)
if the overview fetch fails, but the rest of the page (recent trades,
license, risk posture) still renders since it's fetched independently →
2-column body (`lg:grid-cols-3`): Recent trades `DataTable` (2/3 width,
links to Analytics) + a stacked License card (key prefix, status badge,
device count, "Manage license" → Subscriptions) and Risk posture card
(the governor's live budget numbers — actions/hour, session length,
buy:search ratio, coin flow/hour — "Adjust budgets" → Settings).

### Analytics (`/analytics`)

`PageHeader` with a `DateRangePicker` action → "Net profit" area chart
(full width) → 2-column chart row (Snipe outcomes bar chart with legend,
Coins traded bar chart) → `Tabs` (Activity log table / Filter performance —
the latter is an honest `EmptyState` explaining the read endpoint doesn't
exist yet, not a faked chart, per `07-dashboard.md` "Known API gaps").

### Subscriptions (`/subscriptions`)

Plan cards, checkout/portal links, license key (`CopyField`), device list
with revoke actions. (Existing PHASE 7 implementation; this pass's
polish — sticky-header tables, focus rings, legend — applies here via the
shared components without a page-specific rewrite.)

### Settings (`/settings`)

Profile, password, 2FA management, governor threshold sliders (within
admin-set bounds), notification preferences, telemetry — grouped `Card`
sections, `FormField` + inline validation throughout.

### Admin Panel

- **Overview (`/admin`)**: live `admin.overview.tick` WS counters (Online
  users, Active snipes 1m, Errors 1m) blended with the `DateRangePicker`-
  scoped KPI fetch (Total users, MRR, ARR, Conversion, Churn) → Retention
  line chart (legend: D7/D30) + Extension versions donut (legend:
  per-version) side by side.
- **Users (`/admin/users`)**: search (`q`, now deep-linkable from the
  command palette) + status filter → `DataTable` → row click opens a
  `Drawer` (right side) with profile edit, suspend/ban/reset/force-logout
  actions, each destructive one gated behind `ReasonDialog`.
- **Profits, Activity, System, Subscriptions**: KPI + chart + table
  combinations following the same `ChartCard`/`DataTable` patterns;
  System's health tiles use `Badge` tone to signal up/degraded/down.
- **Audit log (`/admin/audit`)**: searchable table, row click opens a
  `Drawer` with `DiffViewer` (before/after JSON diff) for that entry —
  the one place in the app a raw diff is shown, deliberately monospace and
  syntax-toned rather than prose.
- **Coupons, Plans, Flags, Bans, Feature toggles, Config**: form-heavy
  CRUD pages, all sharing `FormField`/`Input`/`Select`/`Switch` and the
  `DataTable` list pattern.

### 404 / Error

`NotFoundPage` (`Compass` icon, "Page not found", back-to-dashboard
button) and `ErrorPage` (`AlertOctagon` icon in risk-red, error message if
available, Reload button) both render full-bleed on `bg-ground` — they
don't inherit the shell (a broken route shouldn't depend on the shell that
might itself be implicated), and both reuse `EmptyState` rather than a
bespoke layout.

## 12. Performance

- **Code-splitting**: every route component is
  `lazyRouteComponent(() => import(...))` (`router.tsx`) — verified in the
  production build (`pnpm --filter @sl/dashboard build`): each page is its
  own chunk (`DashboardPage-*.js` 5.9KB, `SettingsPage-*.js` 11.8KB,
  `UsersPage-*.js` 10.0KB, etc.), not bundled into the entry chunk.
- **Lazy Recharts**: Recharts itself is not in the entry chunk — its
  shared internals (`generateCategoricalChart-*.js`, 386.7KB/107.2KB
  gzip) and each chart type (`AreaChart-*.js`, `BarChart-*.js`,
  `DonutChart-*.js`) load only when a chart-owning route is visited, via
  the same route-level `lazyRouteComponent` split (charts are imported by
  the page component, not the shell).
- **No layout shift**: `ChartCard` reserves its height before data
  arrives (Skeleton fills the same box); `DataTable` renders skeleton rows
  at the same row height as real ones; `StatTile`/`KpiGrid` render a
  fixed-height tile regardless of loading state (`'…'`/`'—'` placeholder
  text, not a collapsed tile).
- **Web Vitals** — measured with a `PerformanceObserver`-based capture
  (`apps/dashboard/e2e/visual-smoke.spec.ts#captureVitals`, no external
  `web-vitals` package needed) against the **Vite dev server** (not a
  production build — Playwright's `webServer` runs `vite`, per
  `playwright.config.ts`; these numbers are directional, not a
  Lighthouse-grade production budget):

  | Page | TTFB | FCP | LCP | CLS |
  |---|---|---|---|---|
  | `/dashboard` (1440px, authenticated) | 5ms | 412ms | 544ms | 0.00004 |
  | `/login` (1440px) | 5ms | 408ms | 460ms | 0 |

  CLS ≈ 0 on both confirms the "no layout shift" claims above in practice,
  not just by construction. FCP/LCP under 550ms on an unminified dev
  bundle is a reasonable floor; expect both lower still against the
  minified production build (`vite preview`) given the code-splitting in
  §12's chunk listing.
- **Known cost**: the entry chunk (`index-*.js`) is 624KB / 192KB gzip —
  above the 500KB warning threshold `vite build` prints. This is
  React 19 + TanStack Router/Query + Zustand + the design system's Radix
  primitives, not a regression introduced by this pass (this pass added
  ~1KB of Legend/CommandPalette code, itself route-split). Splitting the
  TanStack Query devtools (already dev-only, tree-shaken from
  production — confirmed by their absence from the `dist/assets` listing)
  and further vendor-chunking React/Router are flagged in §14 as a
  follow-up beyond this pass's scope (build-config ownership, not design
  system).

## 13. What this pass changed

Applied against the PHASE 7 baseline (commit `68ff63e`, which already
shipped tokens, ~28 components, 5 chart wrappers and full page
implementations — this pass is polish, not a rebuild):

1. **Chart palette validated & fixed** (§2) — the previous
   `--sl-chart-1..6` (reusing the status green/gold/red/etc. as chart
   marks) failed the `dataviz` skill's validator on lightness, chroma and
   CVD-separation; replaced with a purpose-tuned, validated 6-color ramp.
   `POSITIVE_COLOR`/`NEGATIVE_COLOR` updated to match.
2. **`ChartLegend` + `seriesLegendItems`** added (`packages/ui`) and wired
   into every ≥2-series chart that had none: Analytics "Snipe outcomes",
   Admin Overview "Retention" + "Extension versions", Admin Subscriptions
   "New vs. canceled" + "Plan mix".
3. **`connectNulls` (default `true`)** added to `LineChart`/`AreaChart`
   for gap-filled series.
4. **`DataTable` sticky header** — `thead` is now `sticky top-0 z-10`
   inside a `max-h-[70vh] overflow-auto` scroll region.
5. **Responsive shell**: `Sidebar` hidden below `lg`, replaced by a new
   `Drawer side="left"` mobile nav (Drawer extended to support `side` and
   a chrome-less/no-title mode); topbar reflows (hides secondary chrome
   at `<sm`/`<md`) and gains a hamburger trigger.
6. **Real online indicator**: the topbar's connection dot/label now reads
   `useConnectionStore` (new), fed by `WsConnection`'s new `onStatus`
   callback (`connecting`/`open`/`closed`) — previously a hard-coded
   "Online" dot regardless of actual socket state.
7. **Command palette** (Cmd/Ctrl+K): new `CommandPalette` primitive in
   `packages/ui` + a dashboard-side data wrapper — routes (role-filtered)
   and, for admins, live user-by-email search deep-linking into
   `/admin/users?q=`.
8. **Per-route `<title>`**: `router.tsx` now sets `document.title` on
   every navigation from a single path→title map.
9. **Favicon / app mark**: `apps/dashboard/public/favicon.svg` (gold
   scope-reticle, green center dot, in-palette) + `<link rel="icon">`/
   `<link rel="mask-icon">` in `index.html` (`meta[name=theme-color]` was
   already present and correct).
10. **`EmptyState` gains `titleAs`** (default `"p"`, unchanged for every
    inline usage) — `NotFoundPage`/`ErrorPage` now pass `titleAs="h1"` so
    a full-page 404/error actually has a heading a screen reader
    announces, instead of a bare unstyled `<p>` with no landmark.
11. **Two real accessibility bugs found and fixed** by the new
    `axe-core` e2e suite (§13's "Testing" additions below) — not
    theoretical, both reproduced against the running app:
    - **`link-in-text-block` (serious)**: every "Sign in"/"Create one"/
      "Back to sign in"/"Request a new link"/"View analytics" link that
      sits inline in a sentence relied on `hover:underline` only — no
      visible distinction at rest beyond color. Fixed to a permanent
      `underline` (Login, Register, Forgot/Reset Password, Dashboard).
    - **`aria-allowed-attr` (critical)**: `NotificationsBell`'s
      `DropdownMenuTrigger asChild` wrapped a plain `<div>` (holding the
      bell button + unread-count badge), so Radix's
      `aria-haspopup`/`aria-expanded`/`aria-controls` landed on an
      element whose implicit ARIA role doesn't permit them. Fixed by
      moving the trigger to wrap the real `<button>` (`IconButton`)
      directly and making the positioning `<div>` + badge siblings of the
      trigger instead of its child.
12. **This document.**
13. **Real bug found while trying to widen screenshot coverage to every
    admin sub-page** (`ActivityPage.tsx`): its four raw-activity queries
    (`logins`/`searches`/`snipes`/`errors`) sent `DateRangePicker`'s bare
    `YYYY-MM-DD` `range.from`/`range.to` straight through as `from`/`to`
    query params, but `apps/api`'s `admin-activity` module validates both as
    full `z.string().datetime()` — every request 400'd, so `/admin/activity`
    silently rendered four permanently-broken/empty tabs. `AuditPage.tsx`
    already had the fix for the same mismatch (expand to inclusive UTC day
    bounds, `${range.from}T00:00:00.000Z` / `${range.to}T23:59:59.999Z`);
    `ActivityPage.tsx` now does the same via a small `toRangeQuery()`
    helper. Confirmed by hand (a one-off e2e visit + console-error assertion,
    not committed) that the page loads clean after the fix. This route
    wasn't in the existing visual-smoke screenshot set, which is exactly why
    it went unnoticed — see the note below on why the fix is kept but the
    screenshot-set expansion that surfaced it was not.

### Testing additions

- `apps/dashboard/e2e/accessibility.spec.ts` — `@axe-core/playwright`
  against Login (pre-auth), Dashboard and Admin Overview (post-auth);
  fails on any `serious`/`critical` violation with a readable per-rule
  dump (rule id, impact, offending selector), not just a bare count.
- `apps/dashboard/e2e/visual-smoke.spec.ts` — every named page at
  390/768/1440px: screenshots to `screenshots/`, zero console/page errors
  (filtering exactly one documented sandbox-network artifact — see the
  spec's own comment — never an app-level error), plus the Web Vitals
  capture (§12).
- `apps/dashboard/e2e/helpers/adminAuth.ts` — a shared `loginAsAdmin()`
  used by all three e2e spec files now (this pass refactored
  `dashboard.spec.ts` onto it too, replacing its own duplicated inline
  TOTP-enrollment code). Necessary because `global-setup.ts` only resets
  the seeded admin's TOTP state **once per whole run**, so only whichever
  spec file logs in first actually sees the enrollment screen — every
  login after that in the same run is a step-up **verify**, and the
  secret has to survive across spec files to generate that code. The
  helper detects which screen it got and persists the secret to
  `os.tmpdir()` on enrollment for later specs to read. It also forces a
  **fixed device fingerprint** via `page.addInitScript` (overriding
  `src/lib/device.ts`'s normal random-per-browser-profile one) — without
  that, three spec files' three separately-isolated Playwright contexts
  would each register a *different* device, and the seeded admin's
  plan-less device limit is 1.
- `playwright.config.ts` now sets `workers: 1` — a correctness
  requirement, not a performance choice, once multiple spec files share
  one seeded admin's login state as above; `fullyParallel: false` alone
  only serialises tests *within* a file, not across files.

### Verification run

```
pnpm --filter @sl/ui typecheck   # pass
pnpm --filter @sl/ui lint        # pass
pnpm --filter @sl/ui test        # 3 files, 6 tests, pass
pnpm --filter @sl/ui build       # pass

pnpm --filter @sl/dashboard typecheck   # pass
pnpm --filter @sl/dashboard lint        # pass
pnpm --filter @sl/dashboard test        # 3 files, 11 tests, pass
pnpm --filter @sl/dashboard build       # pass — see §12 chunk listing

pnpm --filter @sl/dashboard test:e2e    # xvfb-run -a, against the real API
                                         # + seeded Postgres/Redis
                                         # 4 passed (accessibility.spec.ts ×2,
                                         # dashboard.spec.ts, visual-smoke.spec.ts)
```

### Screenshot inventory

`apps/dashboard/screenshots/` (27 PNGs, 1.4MB total — well under the 15MB
budget), `<page>-<width>.png`, captured by
`apps/dashboard/e2e/visual-smoke.spec.ts` at 390/768/1440px for every named
page: `login`, `register`, `dashboard`, `analytics`, `subscriptions`,
`settings`, `admin-overview` (Admin Panel), `admin-audit` (Audit Logs), plus
`404`. Confirmed by eye during this pass (not just "the test passed"):
sidebar correctly collapses to a hamburger-triggered drawer at 390/768px,
the topbar's connection dot/Admin badge/search-text hide progressively as
the viewport narrows, the "View analytics" and "Create one"/"Sign in"
links are now visibly underlined (the axe fix in the list below), the
Retention chart's new legend renders (green "D7 retention %" / purple "D30
retention %" dots), and the 404 page is calm and on-brand. Re-run
`test:e2e` after any further visual change rather than trusting these as
permanently current.

## 13a. Resume note (2026-09-21, second interruption)

This pass was re-entered after a second session-rate-limit interruption; the
work above (through §13 item 12) was already committed and verified on
disk. This resume:

- Re-ran the full verification chain (`@sl/ui` and `@sl/dashboard`
  typecheck/lint/test/build, plus `test:e2e` under `xvfb-run`, axe-core
  included) — all still green, confirming nothing regressed since the WIP
  commit.
- Found and fixed the `ActivityPage.tsx` date-range bug in §13 item 13,
  while investigating whether the screenshot inventory should extend past
  the brief's 8 named pages to literally every route (`/admin/users`,
  `/admin/profits`, `/admin/activity`, `/admin/system`,
  `/admin/subscriptions`, `/admin/coupons`, `/admin/plans`, `/admin/flags`,
  `/admin/bans`, `/admin/feature-toggles`, `/admin/config` — 11 more admin
  CRUD pages). That expansion was tried and then **deliberately reverted**:
  tripling `visual-smoke.spec.ts`'s route count (from 9 pages × 3 breakpoints
  to ~19 × 3, all inside one continuous admin session) reproducibly tripped
  `apps/api`'s global rate limit (`RATE_LIMIT_GLOBAL_MAX=300` req/60s,
  `plugins/rate-limit.ts`) on the `/ws` ticket handshake by the third
  breakpoint pass — a real 429, not flakiness, and not something
  `packages/ui`/`apps/dashboard` ownership can fix by widening a timeout.
  Rather than either destabilizing the e2e suite Vercel's build depends on,
  or asking for an `apps/api` config change out of scope, the screenshot set
  stays as documented in §13's original scope decision (the brief's 8 named
  pages). The bug the expansion surfaced (item 13 above) was kept since it's
  real and independently verified; **`/admin/{users,profits,activity,
  system,subscriptions,coupons,plans,flags,bans,feature-toggles,config}`
  still have no dedicated screenshots** — flagged in §14.
- Extension work (`apps/extension/src/{popup,options,ui}`, shared tokens,
  segmented risk gauge, panel sparkline/P&L styling, "What it sends" page,
  `apps/extension/screenshots/`) is gated on `docs/09-security.md` existing
  (file-ownership rule in this pass's brief — the security agent is still
  editing `apps/extension/src` concurrently). Polled for it through this
  session; it had not appeared by the time this pass wrapped up. **Not
  done** — see §14.

## 14. Known gaps / follow-ups

- **Per-admin-role UI gating** — documented gap carried over from
  `07-dashboard.md`; not a design-system concern to fix (needs an API
  change: exposing the caller's `adminRole`).
- **True pinned-first-column** for the widest admin tables (Users, Audit)
  — today those scroll horizontally as a whole (§9); a `sticky left-0`
  first column (with a matching shadow/gradient edge to hint more content)
  would read better once those tables grow past ~6 columns.
- **Entry chunk size** (§12) — vendor-chunking React/Router/Query out of
  the route-split entry is a `vite.config.ts` change, outside
  `packages/ui`/page-component ownership; flagged for whoever owns build
  config next.
- **Command palette** currently searches admin users only — extending it
  to jump straight to a specific coupon/plan/flag/ban record (not just
  the list page) would need those pages' detail views to accept a deep
  link the way Users now does; not done here to keep the palette's first
  version scoped to what the brief asked for (routes + admin user search).
- **Filter performance analytics** (`filter_stats` GET) — pre-existing gap
  from PHASE 7 (`07-dashboard.md`), not touched by this pass; the
  Analytics page's "Filter performance" tab still shows the honest
  `EmptyState` explaining why.
- **Screenshots for the 11 admin CRUD sub-pages** (Users, Profits, Activity,
  System, Subscriptions, Coupons, Plans, Flags, Bans, Feature toggles,
  Config) — not captured; see §13a for why (a real API global-rate-limit
  trip, not a design-system issue) and the cost/benefit reasoning. Doable in
  a follow-up by either raising `apps/api`'s `RATE_LIMIT_GLOBAL_MAX`/
  `RATE_LIMIT_GLOBAL_WINDOW_MS` for the e2e environment (an `apps/api`-owned
  change) or splitting the extra pages into their own lower-frequency e2e
  spec (fewer requests per wall-clock second).
- **Extension surfaces** (`apps/extension/src/{popup,options,ui,styles}`,
  shared design tokens ported into the extension build, segmented risk
  gauge, panel sparkline/P&L styling, options-page inline validation and
  "What it sends" clarity, 360×600 popup, `apps/extension/screenshots/`) —
  **not started this pass**, blocked on `docs/09-security.md` existing per
  this pass's file-ownership gate (the security agent owns
  `apps/extension/src` until that doc lands). Whoever resumes next should
  check for that file first and, once present, pick up PHASE 10's extension
  deliverables from scratch (nothing here has been touched).
