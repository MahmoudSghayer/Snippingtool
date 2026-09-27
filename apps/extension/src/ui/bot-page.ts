/*
 * bot-page.ts — the Nova AI page: a full-height page over EA's content area,
 * opened from the "Nova AI" item this extension adds to EA's left
 * navigation (`ui/ea-nav.ts`).
 *
 * Left: the search Nova AI runs (built like EA's Transfer Market search),
 * the settings it runs on, and the Start bar. Right: the live session —
 * profit, searches, top snipes, the countdown to the next action, counters,
 * the activity log and search results.
 *
 * Start runs the bot on the search as it is filled in on this page: there is
 * no list of saved targets to add to. The search is handed to the bot through
 * `deps.setLiveSearch` and read by it before every search, so an edit while
 * running applies from the next one. It is never written to the user's
 * saved filters.
 *
 * Risk: the settings start on the recommended limits and every number is
 * the user's to change within `BOT_LIMITS`. A risk meter (`botRiskLevel` in
 * @sl/shared) shows the level, the projected searches and buys a day, and
 * the reasons, live as the user edits. The first time the user saves
 * settings above low, the page holds them back until they tick
 * `RISK_ACKNOWLEDGMENT`, and stores `riskAcknowledgedAt`; after that it only
 * shows the level. "Reset to recommended" restores the defaults.
 *
 * Renders in its own closed shadow root: EA's styles cannot reach in, and
 * neither can page scripts (`host.shadowRoot` is null to them). Every
 * user-action handler ignores events a script made (`onTrusted`), so a page
 * script cannot change a limit, acknowledge the risk or press Start. All text
 * that comes from data (card names, error messages) goes through `esc()`.
 *
 * Look: EA FC web app styling, all through the `--ea-*` custom properties on
 * `.page`, so matching the live web app more closely is a token change.
 */
import {
  BOT_RISK_LABELS,
  RISK_ACKNOWLEDGMENT,
  SEARCH_DELAY_PRESETS,
  botRiskLevel,
  botSettingsSchema,
  withRecommendedLimits,
  type BotRiskLevel,
  type BotSettings,
  type FilterCriteria,
} from '@sl/shared';

import {
  SPECIAL_LEVEL,
  fold,
  portraitUrl,
  priceStep,
  raritiesForLevel,
  searchPlayers,
  type Catalog,
  type CatalogOption,
  type CatalogPlayer,
} from '../model/catalog.js';

import { NOVA_LOGO_SVG } from './brand.js';
import { onTrusted } from './trusted-events.js';

import type { Sniper, SniperLogEntry, SniperPhase, SniperSearchResult } from '../engine/sniper.js';

/** The search the bot runs: the one filled in on this page. */
export interface LiveSearch {
  id: string;
  name: string;
  filter: FilterCriteria;
}

export const LIVE_SEARCH_ID = 'live-search';

export interface BotPageDeps {
  /** The bot, once it can run; null while signed out or on a plan without it. */
  getSniper: () => Sniper | null;
  /** Why the bot cannot run, when `getSniper()` is null. */
  getUnavailableReason: () => string | null;
  /** Re-checks sign-in and plan (creating the bot if they now allow it).
   * Called whenever the page opens, so signing in from the account view
   * does not need a page reload. */
  prepare: () => Promise<void>;
  getSettings: () => BotSettings;
  saveSettings: (settings: BotSettings) => Promise<void>;
  /** The search the bot should run from now on (null: none). */
  setLiveSearch: (search: LiveSearch | null) => void;
  resolveNames: (resourceIds: number[]) => Promise<Record<string, string | null>>;
  /** EA's player/club/league/nation lists, if the web app has loaded them
   * since the extension was installed (model/catalog.ts). */
  getCatalog: () => Promise<Catalog | null>;
}

/** Where EA's content area is, in px from each window edge. */
export interface PageBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BotPage {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-render the live side (call when the sniper changes). */
  refresh(): void;
  /** Keep the page inside EA's content area: clear of its navigation and top bar. */
  setBounds(bounds: PageBounds): void;
  onOpenChange(cb: (open: boolean) => void): void;
}

// ---- the search form -------------------------------------------------------

export const OVR_MIN = 45;
export const OVR_MAX = 99;

export interface TargetForm {
  minOvr: number;
  maxOvr: number;
  player: CatalogPlayer | null;
  playerQuery: string;
  quality: string | null;
  rarity: number | null;
  position: string | null;
  chem: number | null;
  nation: number | null;
  league: number | null;
  club: number | null;
  minBuy: number | null;
  maxBuy: number | null;
}

export const blankForm = (): TargetForm => ({
  minOvr: OVR_MIN,
  maxOvr: OVR_MAX,
  player: null,
  playerQuery: '',
  quality: null,
  rarity: null,
  position: null,
  chem: null,
  nation: null,
  league: null,
  club: null,
  minBuy: null,
  maxBuy: null,
});

/** The search the form describes, or what is wrong with it. */
export function buildFilterFromForm(form: TargetForm): { filter: FilterCriteria } | { error: string } {
  const filter: FilterCriteria = {};
  if (form.player) filter.resourceId = form.player.id;
  else if (form.playerQuery.trim()) {
    const n = Number(form.playerQuery.trim());
    if (!Number.isInteger(n) || n <= 0) return { error: 'Pick a player from the list, or type their id' };
    filter.resourceId = n;
  }
  if (form.minOvr > OVR_MIN) filter.minRating = form.minOvr;
  if (form.maxOvr < OVR_MAX) filter.maxRating = form.maxOvr;
  if (form.quality)
    filter.quality = (form.quality === SPECIAL_LEVEL ? 'special' : form.quality) as FilterCriteria['quality'];
  if (form.rarity != null) filter.rarity = form.rarity;
  if (form.position) {
    // EA's position groups (Defenders, Midfielders, Attackers) search as a zone.
    if (/^\d+$/.test(form.position)) filter.zone = Number(form.position);
    else filter.position = form.position;
  }
  if (form.chem != null) filter.chemistryStyle = form.chem;
  if (form.nation != null) filter.nationality = form.nation;
  if (form.league != null) filter.league = form.league;
  if (form.club != null) filter.club = form.club;
  if (form.minBuy != null) filter.minPrice = form.minBuy;
  if (form.maxBuy != null) filter.maxPrice = form.maxBuy;

  if (Object.keys(filter).length === 0) return { error: 'Pick a player or at least one filter' };
  if (filter.minPrice != null && filter.maxPrice != null && filter.minPrice > filter.maxPrice) {
    return { error: 'Min price is above max price' };
  }
  return { filter };
}

const COIN = `<svg class="coin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#f5c542"/><circle cx="8" cy="8" r="4.6" fill="none" stroke="#b8860b" stroke-width="1.4"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>`;
const STOP = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`;

function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function rangeText(r: { min: number; max: number }): string {
  return r.min === r.max ? String(r.min) : `${r.min}-${r.max}`;
}

/** "3", "2-4" or "2 - 4" -> a range; null when unparseable. */
function parseRange(text: string, integer: boolean): { min: number; max: number } | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] != null ? Number(m[2]) : a;
  if (integer && (!Number.isInteger(a) || !Number.isInteger(b))) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

const PHASE_LABEL: Record<SniperPhase, string> = {
  idle: 'Ready',
  searching: 'Searching',
  buying: 'Buying',
  cooldown: 'Pausing after a buy',
  waiting: 'Next search',
  break: 'On a break',
  rest: 'Resting',
  blocked: 'Paused by your limits',
  stopped: 'Stopped',
};

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .page {
    /* EA FC web app look. Not yet checked against the live web app: change
       these values, not the rules below, to match it. */
    --ea-font: "UltimateTeamCondensed", "UltimateTeam", "Segoe UI", system-ui, -apple-system, sans-serif;
    --ea-bg: #0d1522;
    --ea-surface: #152033;
    --ea-surface-2: #1c2a42;
    --ea-control: #243049;
    --ea-control-hover: #2d3c5a;
    --ea-line: #34425c;
    --ea-line-strong: #4a5874;
    --ea-text: #ffffff;
    --ea-text-2: #c7cfdb;
    --ea-muted: #93a0b5;
    --ea-accent: #25e6d0;
    --ea-accent-ink: #062521;
    --ea-focus: #7cf3e4;
    --ea-success: #3ddc84;
    --ea-warning: #f5b83d;
    --ea-danger: #ff5a64;
    --ea-danger-ink: #2b0508;
    --ea-coin: #f5c542;
    --ea-radius: 8px;
    --ea-radius-lg: 12px;

    position: fixed; top: var(--top, 0px); right: var(--right, 0px); bottom: var(--bottom, 0px); left: var(--left, 0px);
    z-index: 2147482000;
    display: flex; flex-direction: column; background: var(--ea-bg); color: var(--ea-text);
    font: 14px/1.45 var(--ea-font); font-variant-numeric: tabular-nums;
  }
  .page[hidden] { display: none; }
  .coin { width: 14px; height: 14px; vertical-align: -2px; margin-left: 4px; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--ea-focus); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; }

  /* header */
  .top { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--ea-line); background: var(--ea-surface); }
  .logo { width: 28px; height: 28px; flex: none; }
  .logo svg { display: block; width: 100%; height: 100%; }
  .top h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: .2px; }
  .ver { color: var(--ea-muted); font-size: 12px; }
  .chip { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: var(--ea-control); color: var(--ea-text-2); }
  .chip.running { background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); }
  .chip.stopped { background: color-mix(in srgb, var(--ea-danger) 18%, transparent); color: var(--ea-danger); }
  .spacer { flex: 1; }
  .risk { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; }
  .risk.low, .lvl.low { background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); }
  .risk.moderate, .lvl.moderate { background: color-mix(in srgb, var(--ea-warning) 18%, transparent); color: var(--ea-warning); }
  .risk.high, .lvl.high { background: color-mix(in srgb, var(--ea-danger) 18%, transparent); color: var(--ea-danger); }
  .risk.very_high, .lvl.very_high { background: var(--ea-danger); color: var(--ea-danger-ink); }
  .saved { color: var(--ea-success); font-size: 13px; min-width: 60px; text-align: right; }
  .close { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--ea-muted); padding: 4px 8px; border-radius: var(--ea-radius); }
  .close:hover { color: var(--ea-text); background: var(--ea-control); }
  .notice { margin: 12px 20px 0; padding: 10px 14px; border-radius: var(--ea-radius); background: color-mix(in srgb, var(--ea-warning) 14%, transparent); color: var(--ea-warning); }
  .notice[hidden] { display: none; }

  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(380px, 42%) 1fr; }

  /* left column: search, settings, Start bar */
  .settings { position: relative; overflow-y: auto; display: flex; flex-direction: column; border-right: 1px solid var(--ea-line); }
  .settings-scroll { flex: 1; padding: 16px 16px 8px; }
  .card { background: var(--ea-surface); border: 1px solid var(--ea-line); border-radius: var(--ea-radius-lg); margin-bottom: 12px; }
  .card > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; font-size: 17px; font-weight: 700; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary .chev { margin-left: auto; color: var(--ea-muted); transition: transform .15s; }
  .card[open] > summary .chev { transform: rotate(180deg); }
  .card .inner { padding: 0 16px 16px; }
  .field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 12px 0; }
  .field + .field { border-top: 1px solid var(--ea-line); }
  .field .name { font-weight: 700; font-size: 14px; }
  .field .help { grid-column: 1; color: var(--ea-muted); font-size: 12px; }
  .field .control { grid-column: 2; grid-row: 1 / span 2; }
  .stepper { display: flex; align-items: center; gap: 4px; border: 1px solid var(--ea-line); border-radius: var(--ea-radius); padding: 3px; background: var(--ea-control); }
  .stepper button { width: 30px; height: 30px; border: 0; border-radius: 6px; background: none; color: var(--ea-text-2); font-size: 18px; line-height: 1; }
  .stepper button:hover { background: var(--ea-control-hover); color: var(--ea-text); }
  .stepper input { width: 64px; border: 0; background: none; color: var(--ea-text); text-align: right; font: inherit; font-size: 15px; font-weight: 700; }
  .stepper input.wide { width: 104px; }
  .stepper .unit { color: var(--ea-muted); font-size: 12px; min-width: 30px; padding-right: 4px; }
  .stepper input[aria-invalid='true'] { color: var(--ea-danger); }
  .stepper:has(input[aria-invalid='true']) { border-color: var(--ea-danger); }
  .presets { display: flex; gap: 8px; justify-content: flex-end; padding: 4px 0 8px; }
  .preset { border: 1px solid var(--ea-line); background: var(--ea-control); border-radius: var(--ea-radius); padding: 6px 10px; text-align: center; min-width: 64px; }
  .preset:hover { background: var(--ea-control-hover); }
  .preset b { display: block; font-size: 13px; }
  .preset small { display: inline-block; margin-top: 3px; padding: 0 6px; border-radius: 4px; font-size: 10px; font-weight: 800; letter-spacing: .3px; }
  .preset[aria-pressed='true'] { border-color: var(--ea-accent); background: color-mix(in srgb, var(--ea-accent) 12%, var(--ea-control)); }
  .tag-low { background: color-mix(in srgb, var(--ea-success) 20%, transparent); color: var(--ea-success); }
  .tag-moderate { background: color-mix(in srgb, var(--ea-warning) 20%, transparent); color: var(--ea-warning); }
  .tag-high, .tag-very_high { background: color-mix(in srgb, var(--ea-danger) 20%, transparent); color: var(--ea-danger); }
  .toggle { position: relative; width: 42px; height: 24px; border-radius: 999px; border: 0; background: var(--ea-line-strong); flex: none; }
  .toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left .15s; }
  .toggle[aria-checked='true'] { background: var(--ea-accent); }
  .toggle[aria-checked='true']::after { left: 21px; }
  .badge-rec { padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--ea-success) 18%, transparent); color: var(--ea-success); font-size: 12px; font-weight: 700; }
  .hint { color: var(--ea-muted); font-size: 12px; padding-top: 8px; }

  .riskbox { background: var(--ea-surface); border: 1px solid var(--ea-line); border-radius: var(--ea-radius-lg); margin-bottom: 12px; padding: 14px 16px; }
  .riskbox.moderate { border-color: color-mix(in srgb, var(--ea-warning) 60%, transparent); }
  .riskbox.high, .riskbox.very_high { border-color: color-mix(in srgb, var(--ea-danger) 70%, transparent); }
  .riskhead { display: flex; align-items: center; gap: 10px; }
  .riskhead b { font-size: 17px; display: flex; align-items: center; gap: 8px; }
  .riskhead .spacer { flex: 1; }
  .ghost, .riskhead button, .ackbox button { border: 1px solid var(--ea-line-strong); background: none; border-radius: var(--ea-radius); padding: 7px 12px; color: var(--ea-text); font-weight: 700; font-size: 13px; }
  .ghost:hover, .riskhead button:hover, .ackbox button:hover { background: var(--ea-control); }
  .lvl { padding: 3px 10px; border-radius: 6px; font-size: 13px; font-weight: 700; }
  .riskbar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 12px 0 8px; }
  .riskbar i { height: 6px; border-radius: 3px; background: var(--ea-line); }
  .riskbar.low i:nth-child(-n+1) { background: var(--ea-success); }
  .riskbar.moderate i:nth-child(-n+2) { background: var(--ea-warning); }
  .riskbar.high i:nth-child(-n+3) { background: var(--ea-danger); }
  .riskbar.very_high i { background: var(--ea-danger); }
  #risk-proj { color: var(--ea-text-2); }
  .riskbox ul { margin: 8px 0 0; padding-left: 18px; color: var(--ea-warning); font-size: 13px; }
  .ackbox { margin-top: 12px; padding: 12px 14px; border-radius: var(--ea-radius); background: var(--ea-bg); border: 1px solid var(--ea-danger); }
  .ackbox[hidden] { display: none; }
  .ackbox p { margin: 0 0 8px; }
  .ackbox label { display: flex; gap: 10px; align-items: flex-start; margin: 10px 0; color: var(--ea-text); }
  .ackbox label input { margin-top: 3px; accent-color: var(--ea-danger); }
  .ackbox button.danger { border-color: var(--ea-danger); color: var(--ea-danger); }
  .ackbox button:disabled { opacity: .45; }

  /* search card: EA's Transfer Market search */
  .combo { position: relative; }
  .suggest { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5; max-height: 280px; overflow-y: auto;
    background: var(--ea-surface-2); border: 1px solid var(--ea-line); border-radius: var(--ea-radius); box-shadow: 0 12px 28px rgba(0,0,0,.5); }
  .suggest[hidden] { display: none; }
  .suggest button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 8px 12px; border: 0; background: none; text-align: left; color: var(--ea-text); }
  .suggest button:hover, .suggest button.active { background: var(--ea-control-hover); }
  .suggest .r, .picked .r { min-width: 26px; font-weight: 800; color: var(--ea-coin); }
  .picked { display: flex; align-items: center; gap: 10px; flex: 1; padding: 8px 0; }
  .picked b { flex: 1; }
  .picked button { border: 0; background: none; color: var(--ea-muted); padding: 4px 8px; border-radius: 6px; }
  .picked button:hover { color: var(--ea-text); background: var(--ea-control); }
  .lbl { color: var(--ea-text-2); font-size: 14px; font-weight: 700; margin: 4px 0 8px; }
  .range2 { position: relative; height: 26px; margin: 0 8px 10px; }
  .range2 .track { position: absolute; left: 0; right: 0; top: 11px; height: 4px; border-radius: 2px; background: var(--ea-line-strong); }
  .range2 .track i { position: absolute; top: 0; bottom: 0; background: var(--ea-accent); border-radius: 2px; }
  .range2 input[type=range] { position: absolute; left: -8px; right: -8px; width: calc(100% + 16px); top: 0; height: 26px; margin: 0;
    background: none; pointer-events: none; -webkit-appearance: none; appearance: none; }
  .range2 input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 20px; height: 20px; border-radius: 50%;
    background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; }
  .range2 input[type=range]::-moz-range-thumb { pointer-events: auto; width: 20px; height: 20px; border-radius: 50%; background: #fff; border: 0; cursor: pointer; }
  .ovr-boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .ovr-boxes label span { display: block; color: var(--ea-muted); font-size: 12px; margin: 0 2px 6px; }
  .ovr-boxes input, .price input { width: 100%; padding: 11px 12px; border-radius: var(--ea-radius); border: 1px solid var(--ea-line); background: var(--ea-control); color: var(--ea-text); font: inherit; font-size: 16px; font-weight: 700; }
  .ea-player { display: flex; align-items: center; gap: 10px; padding: 0 12px; margin-bottom: 10px; min-height: 50px; border-radius: var(--ea-radius);
    border: 1px solid var(--ea-line); background: var(--ea-bg); color: var(--ea-muted); }
  .ea-player input { flex: 1; min-width: 0; padding: 13px 0; border: 0; background: none; color: var(--ea-text); font: inherit; font-size: 16px; outline: none; }
  .ea-player input::placeholder { color: var(--ea-muted); }
  .ea-player:focus-within { border-color: var(--ea-focus); }
  .dd { margin-bottom: 8px; }
  .dd-row { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 6px 14px; border-radius: var(--ea-radius);
    border: 1px solid var(--ea-line); background: var(--ea-control); color: var(--ea-text); text-align: left; }
  .dd-row:hover { background: var(--ea-control-hover); }
  .dd.open .dd-row { border-color: var(--ea-text); border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .dd.set .dd-row { border-color: var(--ea-accent); }
  .dd-icon { width: 26px; display: flex; justify-content: center; }
  .dd-label { flex: 1; font-size: 15px; font-weight: 700; line-height: 1.2; }
  .dd-label small { display: block; font-size: 12px; font-weight: 600; color: var(--ea-muted); }
  .dd-clear { padding: 4px 8px; color: var(--ea-muted); font-size: 14px; border-radius: 6px; }
  .dd-clear:hover { color: var(--ea-text); background: var(--ea-control-hover); }
  .dd-caret { font-size: 12px; color: var(--ea-muted); }
  .dd-panel { border: 1px solid var(--ea-text); border-top: 0; border-radius: 0 0 var(--ea-radius) var(--ea-radius); background: var(--ea-surface-2); padding: 4px 0; }
  .dd-opts { max-height: 280px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ea-line-strong) var(--ea-surface-2); }
  .dd-opt { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 48px; padding: 8px 14px; border: 0; border-radius: 0; background: none; color: var(--ea-text); text-align: left; font-size: 15px; }
  .dd-opt:hover { background: var(--ea-control-hover); }
  .dd-opt[aria-selected='true'] { background: color-mix(in srgb, var(--ea-accent) 22%, var(--ea-surface-2)); font-weight: 700; }
  .dd-opt:focus-visible { outline: none; background: var(--ea-control-hover); }
  .opt-img { flex: none; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .opt-img img { width: 100%; height: 100%; object-fit: contain; }
  .opt-img.noimg { border-radius: 4px; background: var(--ea-line); }
  .opt-img.noimg::after { content: attr(data-initials); font-size: 10px; font-weight: 800; color: var(--ea-text-2); }
  .img-level, .img-pos, .img-chem { width: 30px; height: 30px; }
  .img-card { width: 30px; height: 40px; }
  .img-flag { width: 36px; height: 24px; }
  .img-logo { width: 32px; height: 32px; }
  .dd-icon .opt-img { transform: scale(.8); }
  .dd.disabled .dd-row { opacity: .45; cursor: not-allowed; }
  .dd.disabled .dd-row:hover { background: var(--ea-control); }
  .sg-face { flex: none; width: 34px; height: 34px; border-radius: 50%; overflow: hidden; background: var(--ea-control); }
  .sg-face img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .dd-empty { color: var(--ea-muted); font-size: 13px; padding: 8px 14px; }
  .price { display: grid; grid-template-columns: 40px 44px 1fr 44px; align-items: center; gap: 8px; margin-bottom: 8px; }
  .price-k { color: var(--ea-muted); font-size: 13px; }
  .price input { text-align: center; }
  .price .step { height: 44px; border: 1px solid var(--ea-line); border-radius: var(--ea-radius); background: var(--ea-control); color: var(--ea-text); font-size: 20px; font-weight: 700; }
  .price .step:hover { background: var(--ea-control-hover); }
  .search-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
  .search-hint { color: var(--ea-muted); font-size: 12px; margin-top: 10px; }

  /* Start bar: pinned to the bottom of the settings column */
  .runbar { position: sticky; bottom: 0; z-index: 6; padding: 12px 16px 16px; background: linear-gradient(to top, var(--ea-bg) 78%, transparent); }
  .start { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 50px; border: 0; border-radius: var(--ea-radius);
    background: var(--ea-accent); color: var(--ea-accent-ink); font-size: 17px; font-weight: 800; letter-spacing: .3px;
    box-shadow: 0 6px 18px color-mix(in srgb, var(--ea-accent) 25%, transparent); transition: filter .12s, transform .06s; }
  .start svg { width: 16px; height: 16px; }
  .start:hover:not(:disabled) { filter: brightness(1.08); }
  .start:active:not(:disabled) { transform: translateY(1px); }
  .start.stop { background: var(--ea-danger); color: var(--ea-danger-ink); box-shadow: 0 6px 18px color-mix(in srgb, var(--ea-danger) 25%, transparent); }
  .start:disabled { background: var(--ea-control); color: var(--ea-muted); box-shadow: none; }
  .run-status { margin-top: 8px; min-height: 18px; color: var(--ea-muted); font-size: 13px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-status.bad { color: var(--ea-warning); }

  /* right column: the session */
  .live { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 12px; padding: 16px; overflow: hidden; }
  .live-head { display: flex; align-items: center; gap: 12px; }
  .live-head h2 { margin: 0; font-size: 17px; font-weight: 700; }
  .dash { display: grid; grid-template-columns: 1fr 0.9fr 1.3fr 1.2fr; grid-template-rows: auto auto; gap: 12px; }
  .tile { border-radius: var(--ea-radius-lg); padding: 14px; display: flex; flex-direction: column; justify-content: center; background: var(--ea-surface); border: 1px solid var(--ea-line); }
  .tile .v { font-size: 24px; font-weight: 800; display: flex; align-items: center; }
  .tile .k { font-size: 12px; color: var(--ea-muted); }
  .tile.profit .v { color: var(--ea-coin); }
  .tile.searches .v { color: var(--ea-accent); }
  .panelbox { background: var(--ea-surface); border: 1px solid var(--ea-line); border-radius: var(--ea-radius-lg); padding: 12px 14px; }
  .top-snipes h3 { margin: 0 0 8px; font-size: 14px; font-weight: 700; color: var(--ea-text-2); }
  .ts-row { display: flex; justify-content: space-between; color: var(--ea-text-2); font-size: 13px; padding: 2px 0; }
  .ts-row:first-of-type { color: var(--ea-text); font-size: 15px; font-weight: 700; }
  .counters { grid-row: span 2; display: grid; gap: 6px; }
  .counter { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-radius: var(--ea-radius); background: var(--ea-surface); border: 1px solid var(--ea-line); border-left: 3px solid; font-weight: 600; font-size: 13px; }
  .counter .n { font-size: 15px; font-weight: 800; }
  .c-green { border-left-color: var(--ea-success); } .c-red { border-left-color: var(--ea-danger); } .c-blue { border-left-color: var(--ea-accent); }
  .c-yellow { border-left-color: var(--ea-coin); } .c-orange { border-left-color: var(--ea-warning); }
  .ring-box { grid-column: span 2; display: flex; align-items: center; justify-content: center; position: relative; min-height: 150px; }
  .ring { width: 130px; height: 130px; }
  .ring-label { position: absolute; text-align: center; }
  .ring-label .t { font-size: 30px; font-weight: 800; }
  .ring-label .p { font-size: 12px; color: var(--ea-muted); }
  .elapsed { position: absolute; left: 14px; bottom: 10px; font-size: 12px; color: var(--ea-muted); }
  .elapsed b { display: block; color: var(--ea-text); font-size: 15px; }
  .tl .hd { display: flex; justify-content: space-between; color: var(--ea-text-2); font-size: 13px; }
  .tl .big { font-size: 18px; font-weight: 800; margin-top: 4px; }
  .bar { height: 6px; border-radius: 3px; background: var(--ea-line); margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--ea-success); }

  .feeds { min-height: 0; display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; }
  .feed { min-height: 0; display: flex; flex-direction: column; background: var(--ea-surface); border: 1px solid var(--ea-line); border-radius: var(--ea-radius-lg); overflow: hidden; }
  .feed h3 { margin: 0; padding: 10px 14px; font-size: 14px; font-weight: 700; border-bottom: 1px solid var(--ea-line); }
  .feed .list { flex: 1; overflow-y: auto; padding: 8px; }
  .log { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 6px; border-radius: var(--ea-radius); background: var(--ea-bg); border-left: 3px solid var(--ea-line-strong); }
  .log.bought { border-left-color: var(--ea-success); } .log.failed { border-left-color: var(--ea-danger); } .log.blocked { border-left-color: var(--ea-warning); }
  .log .main { flex: 1; min-width: 0; }
  .log .main b { font-weight: 700; }
  .log .sub { color: var(--ea-muted); font-size: 12px; }
  .pill { padding: 5px 10px; border-radius: var(--ea-radius); font-weight: 800; background: color-mix(in srgb, var(--ea-success) 16%, transparent); color: var(--ea-success); white-space: nowrap; }
  .pill.neg { background: color-mix(in srgb, var(--ea-danger) 16%, transparent); color: var(--ea-danger); }
  .res { font-size: 13px; padding: 3px 6px; color: var(--ea-text-2); }
  .res .when { color: var(--ea-muted); margin-right: 8px; }
  .res.item { display: flex; justify-content: space-between; color: var(--ea-text); background: var(--ea-bg); border-radius: 6px; margin: 2px 0; }
  .empty { color: var(--ea-muted); padding: 18px; text-align: center; }
  .na { color: var(--ea-muted); }

  @media (max-width: 1100px) {
    .body { grid-template-columns: 1fr; overflow-y: auto; }
    .settings { overflow: visible; border-right: 0; }
    .live { overflow: visible; }
    .dash { grid-template-columns: 1fr 1fr; }
    .counters, .ring-box { grid-column: span 2; grid-row: auto; }
    .feeds { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

export function createBotPage(deps: BotPageDeps, doc: Document = document): BotPage {
  const host = doc.createElement('div');
  host.id = 'ledger-bot-page';
  // Closed: the only reference is this closure's.
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const page = doc.createElement('div');
  page.className = 'page';
  page.hidden = true;
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Nova AI');
  root.append(style, page);
  (doc.body || doc.documentElement).appendChild(host);

  const names = new Map<number, string | null>();
  const openListeners = new Set<(open: boolean) => void>();
  let settings = deps.getSettings();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let refreshQueued = false;
  let catalog: Catalog | null = null;
  let catalogPoll: ReturnType<typeof setInterval> | null = null;

  /** Takes the latest catalog; re-renders only when it changed, and never
   * while a list is open (the user may be scrolling it). */
  function loadCatalog(): void {
    void deps.getCatalog().then((c) => {
      if (!c || page.hidden || c.capturedAt === catalog?.capturedAt || openDd) return;
      catalog = c;
      renderTargets();
    });
  }

  page.innerHTML = `
    <div class="top">
      <span class="logo">${NOVA_LOGO_SVG}</span>
      <h1>Nova AI</h1>
      <span class="ver" title="Nova Trade version">v${esc(import.meta.env.VITE_EXTENSION_VERSION)}</span>
      <span class="chip" id="phase">Ready</span>
      <span class="risk" id="risk"></span>
      <span class="spacer"></span>
      <span class="saved" id="saved" aria-live="polite"></span>
      <button class="close" id="close" type="button" aria-label="Close Nova AI">✕</button>
    </div>
    <div class="notice" id="notice" hidden></div>
    <div class="body">
      <div class="settings" id="settings">
        <div class="settings-scroll"><div id="targets"></div><div id="knobs"></div></div>
        <div class="runbar">
          <button class="start" id="start" type="button">${PLAY}<span>Start</span></button>
          <div class="run-status" id="run-status" aria-live="polite"></div>
        </div>
      </div>
      <div class="live">
        <div class="live-head"><h2>This session</h2><span class="spacer"></span>
          <button class="ghost" id="reset" type="button">Reset stats</button></div>
        <div class="dash" id="dash"></div>
        <div class="feeds">
          <section class="feed" aria-label="Nova AI activity"><h3>Activity</h3><div class="list" id="log"></div></section>
          <section class="feed" aria-label="Search results"><h3>Search results</h3><div class="list" id="results"></div></section>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => root.getElementById(id) as T;

  // ---- settings column ----------------------------------------------------

  function stepper(id: string, value: string, unit: string, label: string, wide = false): string {
    return `<div class="stepper control"><button type="button" data-step="${id}" data-dir="-1" aria-label="Less">−</button>
      <input id="${id}" value="${esc(value)}" inputmode="decimal" class="${wide ? 'wide' : ''}" aria-label="${esc(label)}" />
      <span class="unit">${esc(unit)}</span>
      <button type="button" data-step="${id}" data-dir="1" aria-label="More">+</button></div>`;
  }

  function field(name: string, help: string, control: string): string {
    return `<div class="field"><span class="name">${esc(name)}</span><span class="help">${esc(help)}</span>${control}</div>`;
  }

  function toggle(id: string, on: boolean, label: string): string {
    return `<button class="toggle" type="button" role="switch" id="${id}" aria-checked="${on}" aria-label="${esc(label)}"></button>`;
  }

  function section(title: string, body: string, extra = '', open = true): string {
    return `<details class="card" ${open ? 'open' : ''}><summary>${esc(title)}${extra}<span class="chev">⌄</span></summary><div class="inner">${body}</div></details>`;
  }

  function renderSettings(): void {
    renderTargets();
    renderKnobs();
  }

  /** Settings above low the user has not confirmed yet: shown on the page,
   * not saved and not given to the bot until the acknowledgment. */
  let pending: BotSettings | null = null;

  /** What the page shows: the unconfirmed edit, else the saved settings. */
  function shown(): BotSettings {
    return pending ?? settings;
  }

  /** Whether the acknowledgment is outstanding: an unconfirmed edit, or
   * saved settings above low that were never confirmed (an older build's). */
  function ackNeeded(): boolean {
    const s = shown();
    return botRiskLevel(s).level !== 'low' && !s.riskAcknowledgedAt;
  }

  function riskBoxHtml(): string {
    return `<section class="riskbox" id="riskbox" aria-labelledby="risk-title">
      <div class="riskhead"><b id="risk-title">Risk level <span id="risk-level"></span></b><span class="spacer"></span>
        <button type="button" id="reset-rec">Reset to recommended</button></div>
      <div class="riskbar" id="riskbar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div id="risk-proj"></div>
      <ul id="risk-reasons"></ul>
      <div class="ackbox" id="ackbox" hidden>
        <p><b>These settings are above Low risk.</b> Confirm once to save them. A ban is never refundable.</p>
        <label><input type="checkbox" id="ack-check" /> <span>${esc(RISK_ACKNOWLEDGMENT)}</span></label>
        <button type="button" class="danger" id="ack-confirm" disabled>Save these settings</button>
      </div>
      <div class="hint">Based on limits traders have reported for EA's transfer market. Not a guarantee — EA doesn't publish its rules.</div>
    </section>`;
  }

  function renderKnobs(): void {
    const s = shown();
    const delayPreset = SEARCH_DELAY_PRESETS.find(
      (p) => p.min === s.searchDelay.min && p.max === s.searchDelay.max,
    )?.key;
    const presetLevel = (p: { min: number; max: number }): BotRiskLevel =>
      botRiskLevel({ ...s, searchDelay: { min: p.min, max: p.max } }).level;

    $('knobs').innerHTML =
      riskBoxHtml() +
      section(
        'Search speed',
        field(
          'Wait between searches',
          'Seconds between one search and the next',
          stepper('delay', rangeText(s.searchDelay), 'sec', 'Wait between searches'),
        ) +
          `<div class="presets">${SEARCH_DELAY_PRESETS.map((p) => {
            const level = presetLevel(p);
            return `<button type="button" class="preset" data-delay="${p.key}" data-min="${p.min}" data-max="${p.max}" aria-pressed="${delayPreset === p.key}">
            <b>${p.min}-${p.max}</b><small class="tag-${level}">${esc(BOT_RISK_LABELS[level].toUpperCase())}</small></button>`;
          }).join('')}</div>`,
      ) +
      section(
        'Short breaks',
        field(
          'Take a break after',
          'Searches before the bot pauses',
          stepper('b-searches', rangeText(s.breaks.searches), 'searches', 'Take a break after'),
        ) +
          field(
            'Break length',
            'Seconds the bot pauses',
            stepper('b-seconds', rangeText(s.breaks.seconds), 'sec', 'Break length'),
          ),
        `&nbsp;${toggle('b-on', s.breaks.enabled, 'Take short breaks')}`,
      ) +
      section(
        'Long breaks',
        field(
          'Rest after',
          'Minutes of searching before a long break',
          stepper('r-after', rangeText(s.rest.afterMinutes), 'min', 'Rest after', true),
        ) +
          field(
            'Rest length',
            'Minutes the bot rests',
            stepper('r-minutes', rangeText(s.rest.minutes), 'min', 'Rest length', true),
          ) +
          `<div class="hint">Enter one number (30) or a range (20-30). The bot picks a random value in the range each time.</div>`,
        `&nbsp;<span class="badge-rec">Recommended</span>${toggle('r-on', s.rest.enabled, 'Take long breaks')}`,
      ) +
      section(
        'Price limits',
        field(
          "Most you'll pay",
          'Per player. 0 uses the max price in your search',
          stepper('t-max', String(s.thresholds.maxBuyPrice), 'coins', "Most you'll pay", true),
        ) +
          field(
            'Minimum profit',
            "After EA's 5% tax. 0 turns it off",
            stepper('t-profit', String(s.thresholds.minProfit), 'coins', 'Minimum profit', true),
          ) +
          field(
            'Stop after buying',
            'Number of players. 0 means no limit',
            stepper('t-buys', String(s.thresholds.stopAfterPurchases), 'players', 'Stop after buying'),
          ) +
          field(
            'Spending limit',
            'Stop after spending this many coins. 0 means no limit',
            stepper('t-budget', String(s.thresholds.sessionCoinBudget), 'coins', 'Spending limit', true),
          ),
        '',
        false,
      ) +
      section(
        'Safety limits',
        field(
          'Searches per hour',
          'Most searches in any hour',
          stepper('s-sph', String(s.safety.maxSearchesPerHour), 'per hr', 'Searches per hour'),
        ) +
          field(
            'Buys per hour',
            'Most players bought in any hour',
            stepper('s-bph', String(s.safety.maxBuysPerHour), 'per hr', 'Buys per hour'),
          ) +
          field(
            'Hours per day',
            'Most time searching each day, breaks not counted',
            stepper('s-hours', String(s.safety.maxActiveHoursPerDay), 'hours', 'Hours per day'),
          ) +
          field(
            'Coins per hour',
            'Most coins spent in any hour',
            stepper('s-flow', String(s.safety.maxCoinFlowPerHour), 'coins', 'Coins per hour', true),
          ) +
          field(
            'Pause after a buy',
            'Seconds to wait after each purchase',
            stepper('s-cooldown', String(s.safety.cooldownSeconds), 'sec', 'Pause after a buy'),
          ) +
          field(
            'Buys per search',
            'From 0.01 to 1. Lower is safer',
            stepper('s-ratio', String(s.safety.buyToSearchRatio), 'max', 'Buys per search'),
          ),
        '',
        false,
      );
    renderRisk();
  }

  // ---- Search: built like EA's own search panel ----------------------------
  //
  // Same layout as the web app's Club / Transfer Market search: OVR range,
  // player name search, then expandable rows (Quality, Rarity, Position,
  // Chemistry Style, Country/Region, League, Club) and the Buy Now price.
  // What the user has chosen lives in `form`, so re-rendering (opening a row,
  // picking an option) never loses it.

  type Dd = 'quality' | 'rarity' | 'position' | 'chem' | 'nation' | 'league' | 'club';
  const DDS: Dd[] = ['quality', 'rarity', 'position', 'chem', 'nation', 'league', 'club'];

  let form = blankForm();
  let openDd: Dd | null = null;
  // Type-to-jump in an open list, like a native dropdown (EA's lists have
  // no search box).
  let typeahead = '';
  let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;
  let suggestions: CatalogPlayer[] = [];

  const DD_LABEL: Record<Dd, string> = {
    quality: 'Quality',
    rarity: 'Rarity',
    position: 'Position',
    chem: 'Chemistry Style',
    nation: 'Country/Region',
    league: 'League',
    club: 'Club',
  };

  const svg = (body: string) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${body}</svg>`;
  const DD_ICON: Record<Dd, string> = {
    quality: svg(
      '<path d="M5 3h14v11c0 4-4 6-7 7-3-1-7-3-7-7z" fill="#fff"/><text x="12" y="12.5" text-anchor="middle" font-size="6.5" font-weight="900" font-style="italic" fill="#1b2433">FUT</text>',
    ),
    rarity: svg(
      '<ellipse cx="12" cy="6" rx="7" ry="2.6" fill="#fff"/><path d="M5 6v11c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6c0 1.5-3.1 2.7-7 2.7S5 7.5 5 6z" fill="#cfd6df"/>',
    ),
    position: svg(
      '<circle cx="12" cy="4.5" r="2.3" fill="#fff"/><path d="M9.5 8h5l1 6-2 .5-.5 8h-2l-.5-8-2-.5z" fill="#fff"/>',
    ),
    chem: svg(
      '<path d="M3 15c3 0 6-1 8-4l2 2c1 1 3 2 5 2h3v3H4c-.6 0-1-.4-1-1z" fill="#fff"/><path d="M6 19h2v1H6zm4 0h2v1h-2zm4 0h2v1h-2z" fill="#fff"/>',
    ),
    nation: svg(
      '<path d="M5 3v18" stroke="#fff" stroke-width="1.6"/><path d="M5.5 4h9l-1.5 3 1.5 3h-9z" fill="#fff"/><circle cx="17" cy="16" r="3.2" fill="none" stroke="#fff" stroke-width="1.4"/>',
    ),
    league: svg(
      '<path d="M4 7l4 3 4-6 4 6 4-3-2 10H6z" fill="#fff"/><rect x="6" y="18" width="12" height="2" fill="#fff"/>',
    ),
    club: svg('<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" fill="#fff"/>'),
  };

  /** Used only until the web app has started and the adapter has built
   * the catalog from EA's own lists (they need no id to be meaningful). */
  const LEVEL_IMG =
    'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/images/SearchFilters/level/';
  const FALLBACK_LEVELS: CatalogOption[] = [
    { id: 0, value: 'bronze', label: 'Bronze', img: `${LEVEL_IMG}bronze.png` },
    { id: 1, value: 'silver', label: 'Silver', img: `${LEVEL_IMG}silver.png` },
    { id: 2, value: 'gold', label: 'Gold', img: `${LEVEL_IMG}gold.png` },
    { id: 3, value: SPECIAL_LEVEL, label: 'Special', img: `${LEVEL_IMG}SP.png` },
  ];

  /** EA's list for a row, exactly as the web app's search panel shows it. */
  function ddOptions(dd: Dd): CatalogOption[] {
    switch (dd) {
      case 'quality':
        return catalog?.levels.length ? catalog.levels : FALLBACK_LEVELS;
      case 'rarity':
        return raritiesForLevel(catalog?.rarities ?? [], form.quality);
      case 'position':
        return catalog?.positions ?? [];
      case 'chem':
        return catalog?.playStyles ?? [];
      case 'nation':
        return catalog?.nations ?? [];
      case 'league':
        return catalog?.leagues ?? [];
      case 'club':
        return form.league == null ? [] : (catalog?.clubs[String(form.league)] ?? []);
    }
  }

  function ddValue(dd: Dd): string | null {
    const v = {
      quality: form.quality,
      rarity: form.rarity,
      position: form.position,
      chem: form.chem,
      nation: form.nation,
      league: form.league,
      club: form.club,
    }[dd];
    return v == null ? null : String(v);
  }

  /** The chosen entry of a row (by EA value for quality/position, by id otherwise). */
  function ddChosen(dd: Dd): CatalogOption | null {
    const v = ddValue(dd);
    if (v == null) return null;
    const byValue = dd === 'quality' || dd === 'position';
    return ddOptions(dd).find((o) => (byValue ? o.value : String(o.id)) === v) ?? null;
  }

  function ddLabel(dd: Dd): string | null {
    const v = ddValue(dd);
    if (v == null) return null;
    return ddChosen(dd)?.label ?? `#${v}`;
  }

  /** Mirrors the web app's search panel: picking a quality clears the
   * rarity (its `LEVEL` filter sets `rarities = []`), and a new league
   * clears the club (a club belongs to one league). */
  function setDd(dd: Dd, value: string | null): void {
    const n = value == null ? null : Number(value);
    if (dd === 'quality') {
      form.quality = value;
      form.rarity = null;
    } else if (dd === 'position') form.position = value;
    else if (dd === 'rarity') form.rarity = n;
    else if (dd === 'chem') form.chem = n;
    else if (dd === 'nation') form.nation = n;
    else if (dd === 'league') {
      if (form.league !== n) form.club = null;
      form.league = n;
    } else form.club = n;
  }

  const IMG_CLASS: Record<Dd, string> = {
    quality: 'img-level',
    rarity: 'img-card',
    position: 'img-pos',
    chem: 'img-chem',
    nation: 'img-flag',
    league: 'img-logo',
    club: 'img-logo',
  };

  /** EA's picture for an entry, with the name's initials if it will not load. */
  function optVisual(dd: Dd, o: CatalogOption): string {
    const initials = esc(
      o.label
        .replace(/\(.*?\)/g, '')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase(),
    );
    return `<span class="opt-img ${IMG_CLASS[dd]}${o.img ? '' : ' noimg'}" data-initials="${initials}">${
      o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''
    }</span>`;
  }

  function ddOptionsHtml(dd: Dd): string {
    const current = ddChosen(dd);
    return ddOptions(dd)
      .map((o) => {
        const val = dd === 'quality' || dd === 'position' ? o.value : String(o.id);
        return `<button type="button" class="dd-opt" role="option" aria-selected="${o === current}" data-opt="${dd}" data-val="${esc(val)}">${optVisual(dd, o)}<span>${esc(o.label)}</span></button>`;
      })
      .join('');
  }

  function ddHtml(dd: Dd): string {
    const label = ddLabel(dd);
    const chosen = ddChosen(dd);
    // Like EA's panel: Club stays disabled until a league is chosen.
    const disabled = dd === 'club' && form.league == null;
    const open = openDd === dd && !disabled;
    const options = ddOptions(dd);
    let panel = '';
    if (open) {
      panel =
        options.length === 0
          ? `<div class="dd-panel"><div class="dd-empty">${
              catalog
                ? 'Nothing to choose here.'
                : "Loading EA's lists. Keep the web app open and signed in."
            }</div></div>`
          : `<div class="dd-panel"><div class="dd-opts" id="dd-opts" role="listbox" aria-label="${esc(DD_LABEL[dd])}">${ddOptionsHtml(dd)}</div></div>`;
    }
    return `<div class="dd${open ? ' open' : ''}${label ? ' set' : ''}${disabled ? ' disabled' : ''}">
      <button type="button" class="dd-row" data-dd="${dd}" aria-expanded="${open}" ${disabled ? 'disabled aria-disabled="true"' : ''}>
        <span class="dd-icon">${chosen ? optVisual(dd, chosen) : DD_ICON[dd]}</span>
        <span class="dd-label">${label ? `<small>${esc(DD_LABEL[dd])}</small>${esc(label)}` : esc(DD_LABEL[dd])}</span>
        ${label ? `<span class="dd-clear" data-clear="${dd}" role="button" aria-label="Clear ${esc(DD_LABEL[dd])}">✕</span>` : ''}
        <span class="dd-caret">${open ? '▲' : '▼'}</span>
      </button>${panel}</div>`;
  }

  function describeFilter(f: FilterCriteria): string[] {
    const byId = (list: CatalogOption[] | undefined, id: number) =>
      list?.find((e) => e.id === id)?.label;
    const chips: string[] = [];
    if (f.resourceId != null) {
      const p = catalog?.players.find((x) => x.id === f.resourceId);
      chips.push(p ? `${p.rating ?? ''} ${p.name}`.trim() : `Player #${f.resourceId}`);
    }
    if (f.minRating != null || f.maxRating != null)
      chips.push(`OVR ${f.minRating ?? OVR_MIN}-${f.maxRating ?? OVR_MAX}`);
    if (f.quality) {
      const v = f.quality === 'special' ? SPECIAL_LEVEL : f.quality;
      chips.push(
        (catalog?.levels.length ? catalog.levels : FALLBACK_LEVELS).find((l) => l.value === v)
          ?.label ?? f.quality,
      );
    }
    if (f.rarity != null) chips.push(byId(catalog?.rarities, f.rarity) ?? `Rarity #${f.rarity}`);
    if (f.zone != null) chips.push(byId(catalog?.positions, f.zone) ?? `Zone #${f.zone}`);
    else if (f.position)
      chips.push(catalog?.positions.find((p) => p.value === f.position)?.label ?? f.position);
    if (f.chemistryStyle != null)
      chips.push(byId(catalog?.playStyles, f.chemistryStyle) ?? `Chem #${f.chemistryStyle}`);
    if (f.nationality != null)
      chips.push(byId(catalog?.nations, f.nationality) ?? `Nation #${f.nationality}`);
    if (f.league != null) chips.push(byId(catalog?.leagues, f.league) ?? `League #${f.league}`);
    if (f.club != null) {
      const clubs =
        f.league != null
          ? catalog?.clubs[String(f.league)]
          : Object.values(catalog?.clubs ?? {}).flat();
      chips.push(byId(clubs, f.club) ?? `Club #${f.club}`);
    }
    if (f.minPrice != null) chips.push(`min ${fmt(f.minPrice)}`);
    chips.push(f.maxPrice != null ? `max ${fmt(f.maxPrice)}` : 'no max price');
    return chips;
  }

  function ovrFill(): string {
    const span = OVR_MAX - OVR_MIN;
    return `left:${((form.minOvr - OVR_MIN) / span) * 100}%;right:${((OVR_MAX - form.maxOvr) / span) * 100}%`;
  }

  function priceHtml(key: 'minBuy' | 'maxBuy', label: string): string {
    const v = form[key];
    return `<div class="price"><span class="price-k">${label}</span>
      <button type="button" class="step" data-price="${key}" data-dir="-1" aria-label="Lower ${label.toLowerCase()} price">−</button>
      <input id="nf-${key}" inputmode="numeric" placeholder="Any" value="${v == null ? '' : fmt(v)}" aria-label="${label} buy now price" />
      <button type="button" class="step" data-price="${key}" data-dir="1" aria-label="Raise ${label.toLowerCase()} price">+</button></div>`;
  }

  function renderTargets(): void {
    const wasOpen = root.querySelector('#targets details')?.hasAttribute('open') ?? true;
    const players = catalog?.players.length ?? 0;
    const hint = !catalog
      ? "Loading EA's lists and players. Keep the web app open; they appear here on their own."
      : `${fmt(players)} players from EA's player list.${catalog.notes?.length ? ` Problems: ${catalog.notes.join(', ')}` : ''}`;

    $('targets').innerHTML = section(
      'Search',
      `<div id="ea-search">
        <div class="lbl">Rating</div>
        <div class="range2">
          <div class="track"><i id="ovr-fill" style="${ovrFill()}"></i></div>
          <input type="range" id="nf-ovr-lo" min="${OVR_MIN}" max="${OVR_MAX}" value="${form.minOvr}" aria-label="Min rating" />
          <input type="range" id="nf-ovr-hi" min="${OVR_MIN}" max="${OVR_MAX}" value="${form.maxOvr}" aria-label="Max rating" />
        </div>
        <div class="ovr-boxes">
          <label><span>Min</span><input id="nf-minovr" inputmode="numeric" value="${form.minOvr}" /></label>
          <label><span>Max</span><input id="nf-maxovr" inputmode="numeric" value="${form.maxOvr}" /></label>
        </div>
        <div class="ea-player combo">${
          form.player
            ? `<div class="picked">${
                portraitUrl(catalog, form.player.id)
                  ? `<span class="sg-face"><img src="${esc(portraitUrl(catalog, form.player.id)!)}" alt="" referrerpolicy="no-referrer" /></span>`
                  : ''
              }<span class="r">${form.player.rating ?? ''}</span><b>${esc(form.player.name)}</b>
                <button type="button" id="nf-unpick" aria-label="Clear player">✕</button></div>`
            : `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
               <input id="nf-player" placeholder="${players > 0 ? 'Player name' : 'Player name or id'}" autocomplete="off" value="${esc(form.playerQuery)}"
                role="combobox" aria-label="Player" aria-expanded="false" aria-controls="nf-suggest" aria-autocomplete="list" />
               <div class="suggest" id="nf-suggest" role="listbox" hidden></div>`
        }</div>
        ${DDS.map(ddHtml).join('')}
        <div class="lbl" style="margin-top:16px">Buy now price</div>
        ${priceHtml('minBuy', 'Min')}
        ${priceHtml('maxBuy', 'Max')}
        <div class="search-actions"><button type="button" class="ghost" id="nf-reset">Clear search</button></div>
        <div class="search-hint">${esc(hint)}</div>
      </div>`,
      '',
      wasOpen,
    );
    if (openDd) {
      const opt =
        root.querySelector<HTMLElement>('.dd.open .dd-opt[aria-selected="true"]') ??
        root.querySelector<HTMLElement>('.dd.open .dd-opt');
      opt?.scrollIntoView({ block: 'nearest' });
      opt?.focus({ preventScroll: true });
    }
    syncSearch();
  }

  /** The form as the search the bot runs, or what is wrong with it. */
  function currentSearch(): { search: LiveSearch } | { error: string } {
    const built = buildFilterFromForm(form);
    if ('error' in built) return built;
    const name = describeFilter(built.filter).join(', ').slice(0, 80);
    return { search: { id: LIVE_SEARCH_ID, name, filter: built.filter } };
  }

  /** Hands the form to the bot. While it runs, an unfinished edit (say, a
   * name typed but not picked yet) keeps the last complete search. */
  function syncSearch(): void {
    const running = deps.getSniper()?.isRunning() ?? false;
    const r = currentSearch();
    if ('search' in r) deps.setLiveSearch(r.search);
    else if (!running) deps.setLiveSearch(null);
    renderRunbar();
  }

  function showSuggestions(query: string): void {
    const box = root.getElementById('nf-suggest');
    const input = root.getElementById('nf-player');
    if (!box || !input) return;
    suggestions = catalog ? searchPlayers(catalog.players, query) : [];
    box.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(!box.hidden));
    box.innerHTML = suggestions
      .map((p, i) => {
        const face = portraitUrl(catalog, p.id);
        return `<button type="button" role="option" data-pick="${i}">${
          face
            ? `<span class="sg-face"><img src="${esc(face)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
            : ''
        }<span class="r">${p.rating ?? ''}</span>${esc(p.name)}</button>`;
      })
      .join('');
  }

  function setOvr(lo: number, hi: number): void {
    const clamp = (n: number) => Math.min(OVR_MAX, Math.max(OVR_MIN, Math.round(n)));
    form.minOvr = clamp(Math.min(lo, hi));
    form.maxOvr = clamp(Math.max(lo, hi));
    const set = (id: string, v: number) => {
      const el = root.getElementById(id) as HTMLInputElement | null;
      if (el && el.value !== String(v)) el.value = String(v);
    };
    set('nf-ovr-lo', form.minOvr);
    set('nf-ovr-hi', form.maxOvr);
    set('nf-minovr', form.minOvr);
    set('nf-maxovr', form.maxOvr);
    root.getElementById('ovr-fill')?.setAttribute('style', ovrFill());
  }

  function parsePrice(text: string): number | null {
    const n = Number(text.replace(/[,\s]/g, ''));
    return text.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n));
  }

  const say = (text: string, bad = true) => {
    $('saved').style.color = bad ? 'var(--ea-danger)' : '';
    $('saved').textContent = text;
  };

  onTrusted($('targets'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-clear],button');
    if (!el) return;
    if (el.dataset.clear) {
      e.stopPropagation();
      setDd(el.dataset.clear as Dd, null);
      renderTargets();
    } else if (el.dataset.dd) {
      const dd = el.dataset.dd as Dd;
      openDd = openDd === dd ? null : dd;
      renderTargets();
    } else if (el.dataset.opt) {
      setDd(el.dataset.opt as Dd, el.dataset.val ?? null);
      openDd = null;
      renderTargets();
    } else if (el.dataset.pick) {
      const p = suggestions[Number(el.dataset.pick)];
      if (!p) return;
      form.player = p;
      form.playerQuery = '';
      suggestions = [];
      renderTargets();
    } else if (el.id === 'nf-unpick') {
      form.player = null;
      renderTargets();
    } else if (el.dataset.price) {
      const key = el.dataset.price as 'minBuy' | 'maxBuy';
      const dir = Number(el.dataset.dir) as 1 | -1;
      form[key] = priceStep(form[key] ?? 0, dir) || null;
      const input = root.getElementById(`nf-${key}`) as HTMLInputElement | null;
      if (input) input.value = form[key] == null ? '' : fmt(form[key]!);
      syncSearch();
    } else if (el.id === 'nf-reset') {
      form = blankForm();
      openDd = null;
      renderTargets();
    }
    // A button inside <summary> must not also fold the card.
    if (el.closest('summary')) e.preventDefault();
  });

  // A flag or logo EA does not have (or a guessed image path that is wrong)
  // falls back to the name's initials. `error` does not bubble: capture it.
  $('targets').addEventListener(
    'error',
    (e) => {
      const img = e.target as HTMLElement;
      if (img.tagName !== 'IMG') return;
      img.parentElement?.classList.add('noimg');
      img.remove();
    },
    true,
  );

  onTrusted($('targets'), 'input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player') {
      form.playerQuery = t.value;
      showSuggestions(t.value);
    } else if (t.id === 'nf-ovr-lo')
      setOvr(Number(t.value), Math.max(Number(t.value), form.maxOvr));
    else if (t.id === 'nf-ovr-hi') setOvr(Math.min(Number(t.value), form.minOvr), Number(t.value));
    else return;
    syncSearch();
  });

  onTrusted($('targets'), 'change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-minovr' || t.id === 'nf-maxovr') {
      const n = Number(t.value);
      if (!Number.isFinite(n)) setOvr(form.minOvr, form.maxOvr);
      else if (t.id === 'nf-minovr') setOvr(n, Math.max(n, form.maxOvr));
      else setOvr(Math.min(n, form.minOvr), n);
    } else if (t.id === 'nf-minBuy' || t.id === 'nf-maxBuy') {
      const key = t.id === 'nf-minBuy' ? 'minBuy' : 'maxBuy';
      form[key] = parsePrice(t.value);
      t.value = form[key] == null ? '' : fmt(form[key]!);
    } else return;
    syncSearch();
  });

  onTrusted($('targets'), 'keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player' && e.key === 'Enter' && suggestions[0]) {
      e.preventDefault();
      form.player = suggestions[0];
      form.playerQuery = '';
      suggestions = [];
      renderTargets();
    } else if (
      openDd &&
      t.classList?.contains('dd-opt') &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp')
    ) {
      e.preventDefault();
      const next = (
        e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling
      ) as HTMLElement | null;
      next?.focus();
    } else if (
      openDd &&
      e.key.length === 1 &&
      /\p{L}|\p{N}/u.test(e.key) &&
      !(t instanceof HTMLInputElement)
    ) {
      typeahead += fold(e.key);
      if (typeaheadTimer) clearTimeout(typeaheadTimer);
      typeaheadTimer = setTimeout(() => (typeahead = ''), 700);
      const hit = [...root.querySelectorAll<HTMLElement>('.dd.open .dd-opt')].find((b) =>
        fold(b.textContent ?? '')
          .trim()
          .startsWith(typeahead),
      );
      hit?.scrollIntoView({ block: 'nearest' });
      hit?.focus({ preventScroll: true });
    } else if (e.key === 'Escape' && openDd) {
      e.stopPropagation();
      openDd = null;
      renderTargets();
    }
  });

  function renderRisk(): void {
    const risk = botRiskLevel(shown());
    const label = BOT_RISK_LABELS[risk.level];
    const chip = $('risk');
    chip.className = `risk ${risk.level}`;
    chip.textContent = `Risk: ${label}`;
    renderRunbar();
    const box = root.getElementById('riskbox');
    if (!box) return;
    box.className = `riskbox ${risk.level}`;
    $('risk-level').textContent = label;
    $('risk-level').className = `lvl ${risk.level}`;
    $('riskbar').className = `riskbar ${risk.level}`;
    $('risk-proj').textContent = `About ${fmt(risk.projectedSearchesPerDay)} searches and ${fmt(risk.projectedBuysPerDay)} buys a day at most.`;
    $('risk-reasons').innerHTML = risk.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    const ack = $('ackbox');
    const needed = ackNeeded();
    if (ack.hidden === needed) {
      ack.hidden = !needed;
      const check = root.getElementById('ack-check') as HTMLInputElement | null;
      if (check) check.checked = false;
      ($('ack-confirm') as HTMLButtonElement).disabled = true;
    }
  }

  /** Reads every field; returns null (and marks the bad ones) if any is invalid. */
  function readSettings(): BotSettings | null {
    let ok = true;
    const field = (id: string) => root.getElementById(id) as HTMLInputElement | null;
    const mark = (id: string, valid: boolean) => {
      field(id)?.setAttribute('aria-invalid', String(!valid));
      if (!valid) ok = false;
    };
    const rng = (id: string, integer: boolean, fallback: { min: number; max: number }) => {
      const el = field(id);
      if (!el) return fallback;
      const r = parseRange(el.value, integer);
      mark(id, r != null);
      return r ?? fallback;
    };
    const n = (id: string, fallback: number) => {
      const el = field(id);
      if (!el) return fallback;
      const v = Number(el.value.replace(/[,\s]/g, ''));
      mark(id, el.value.trim() !== '' && Number.isFinite(v));
      return Number.isFinite(v) ? v : fallback;
    };
    const s = shown();
    const next: BotSettings = {
      riskAcknowledgedAt: s.riskAcknowledgedAt,
      searchDelay: rng('delay', false, s.searchDelay),
      breaks: {
        enabled: s.breaks.enabled,
        searches: rng('b-searches', true, s.breaks.searches),
        seconds: rng('b-seconds', true, s.breaks.seconds),
      },
      rest: {
        enabled: s.rest.enabled,
        afterMinutes: rng('r-after', true, s.rest.afterMinutes),
        minutes: rng('r-minutes', true, s.rest.minutes),
      },
      thresholds: {
        maxBuyPrice: n('t-max', s.thresholds.maxBuyPrice),
        minProfit: n('t-profit', s.thresholds.minProfit),
        stopAfterPurchases: n('t-buys', s.thresholds.stopAfterPurchases),
        sessionCoinBudget: n('t-budget', s.thresholds.sessionCoinBudget),
      },
      safety: {
        maxSearchesPerHour: n('s-sph', s.safety.maxSearchesPerHour),
        maxBuysPerHour: n('s-bph', s.safety.maxBuysPerHour),
        maxActiveHoursPerDay: n('s-hours', s.safety.maxActiveHoursPerDay),
        buyToSearchRatio: n('s-ratio', s.safety.buyToSearchRatio),
        cooldownSeconds: n('s-cooldown', s.safety.cooldownSeconds),
        maxCoinFlowPerHour: n('s-flow', s.safety.maxCoinFlowPerHour),
      },
    };
    const parsed = botSettingsSchema.safeParse(next);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join('.') ?? '';
      const byPath: Record<string, string> = {
        searchDelay: 'delay',
        'breaks.searches': 'b-searches',
        'breaks.seconds': 'b-seconds',
        'rest.afterMinutes': 'r-after',
        'rest.minutes': 'r-minutes',
        'thresholds.maxBuyPrice': 't-max',
        'thresholds.minProfit': 't-profit',
        'thresholds.stopAfterPurchases': 't-buys',
        'thresholds.sessionCoinBudget': 't-budget',
        'safety.maxSearchesPerHour': 's-sph',
        'safety.maxBuysPerHour': 's-bph',
        'safety.maxActiveHoursPerDay': 's-hours',
        'safety.buyToSearchRatio': 's-ratio',
        'safety.cooldownSeconds': 's-cooldown',
        'safety.maxCoinFlowPerHour': 's-flow',
      };
      const key = Object.keys(byPath).find((k) => path.startsWith(k));
      if (key) mark(byPath[key]!, false);
      say(parsed.error.issues[0]?.message ? `Not saved: ${parsed.error.issues[0].message}` : 'Not saved');
      return null;
    }
    return ok ? parsed.data : null;
  }

  /** Applies an edit. Above low and never confirmed: shown, but held back
   * until the acknowledgment. Otherwise saved and given to the bot. */
  function commit(next: BotSettings, rerender: boolean): void {
    if (botRiskLevel(next).level !== 'low' && !next.riskAcknowledgedAt) {
      pending = next;
      if (saveTimer) clearTimeout(saveTimer);
      if (rerender) renderKnobs();
      else renderRisk();
      say('Not saved yet: confirm the risk level above');
      return;
    }
    pending = null;
    settings = next;
    deps.getSniper()?.setSettings(next);
    if (rerender) renderKnobs();
    else renderRisk();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void deps.saveSettings(settings).then(() => {
        say('Saved', false);
        setTimeout(() => ($('saved').textContent = ''), 1500);
      });
    }, 400);
  }

  const STEPS: Record<string, number> = {
    delay: 0.5,
    'b-searches': 1,
    'b-seconds': 5,
    'r-after': 5,
    'r-minutes': 5,
    't-max': 1000,
    't-profit': 500,
    't-buys': 1,
    't-budget': 10_000,
    's-sph': 25,
    's-bph': 1,
    's-hours': 1,
    's-ratio': 0.05,
    's-cooldown': 5,
    's-flow': 100_000,
  };

  onTrusted($('knobs'), 'click', (e) => {
    const el = (e.target as HTMLElement).closest('button');
    if (!el) return;
    if (el.dataset.step) {
      const input = root.getElementById(el.dataset.step) as HTMLInputElement;
      const step = (STEPS[el.dataset.step] ?? 1) * Number(el.dataset.dir);
      const r = parseRange(input.value.replace(/[,\s]/g, ''), false);
      if (!r) return;
      const round = (v: number) => Math.max(0, Math.round(v * 100) / 100);
      input.value =
        r.min === r.max
          ? String(round(r.min + step))
          : `${round(r.min + step)}-${round(r.max + step)}`;
      const next = readSettings();
      if (next) commit(next, false);
    } else if (el.dataset.delay) {
      const min = Number(el.dataset.min);
      const max = Number(el.dataset.max);
      commit({ ...shown(), searchDelay: { min, max } }, true);
    } else if (el.id === 'reset-rec') {
      commit(withRecommendedLimits(shown()), true);
      say('Reset to recommended', false);
    } else if (el.id === 'ack-confirm') {
      const check = root.getElementById('ack-check') as HTMLInputElement | null;
      if (!check?.checked) return;
      commit({ ...shown(), riskAcknowledgedAt: new Date().toISOString() }, true);
    } else if (el.id === 'b-on') {
      const s = shown();
      commit({ ...s, breaks: { ...s.breaks, enabled: !s.breaks.enabled } }, true);
    } else if (el.id === 'r-on') {
      const s = shown();
      commit({ ...s, rest: { ...s.rest, enabled: !s.rest.enabled } }, true);
    }
    // A toggle or preset inside <summary> must not also fold the card.
    if (el.closest('summary')) e.preventDefault();
  });

  onTrusted($('knobs'), 'change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id === 'ack-check') {
      ($('ack-confirm') as HTMLButtonElement).disabled = !input.checked;
      return;
    }
    if (!input.id) return;
    const next = readSettings();
    if (next) commit(next, false);
  });

  // ---- Start bar ------------------------------------------------------------

  function renderRunbar(): void {
    const start = root.getElementById('start') as HTMLButtonElement | null;
    const status = root.getElementById('run-status');
    if (!start || !status) return;
    const sniper = deps.getSniper();
    const running = sniper?.isRunning() ?? false;
    const r = currentSearch();
    let text: string;
    let bad = false;
    if (!sniper) {
      text = deps.getUnavailableReason() ?? 'Nova AI is not available right now.';
      bad = true;
    } else if (running) {
      const startedAt = sniper.getStats().startedAt;
      text = `Running for ${clock(startedAt ? Date.now() - startedAt : 0)}`;
      if ('error' in r) text += `. Search not updated: ${r.error}`;
    } else if (ackNeeded()) {
      text = 'Confirm the risk level above to start';
      bad = true;
    } else if ('error' in r) {
      text = r.error;
      bad = true;
    } else {
      text = `Searches for ${r.search.name}`;
    }
    const label = running ? 'Stop' : 'Start';
    if (start.dataset.label !== label) {
      start.dataset.label = label;
      start.innerHTML = `${running ? STOP : PLAY}<span>${label}</span>`;
    }
    start.classList.toggle('stop', running);
    start.disabled = !sniper || (!running && ackNeeded());
    start.title = start.disabled ? text : '';
    status.textContent = text;
    status.classList.toggle('bad', bad);
  }

  // ---- live side ----------------------------------------------------------

  function nameOf(resourceId: number | undefined): string {
    if (resourceId == null) return '';
    const n = names.get(resourceId);
    return n ?? `#${resourceId}`;
  }

  function wantNames(ids: (number | undefined)[]): void {
    const missing = [...new Set(ids.filter((id): id is number => id != null && !names.has(id)))];
    if (missing.length === 0) return;
    for (const id of missing) names.set(id, null);
    void deps.resolveNames(missing.slice(0, 50)).then((found) => {
      let changed = false;
      for (const [id, name] of Object.entries(found)) {
        if (name) {
          names.set(Number(id), name);
          changed = true;
        }
      }
      if (changed) queueRefresh();
    });
  }

  function renderDash(): void {
    const sniper = deps.getSniper();
    const stats = sniper?.getStats();
    const top = stats?.topSnipes ?? [];
    wantNames(top.map((t) => t.assetId ?? t.resourceId));
    $('dash').innerHTML = `
      <div class="tile profit"><div class="v">${fmt(stats?.profit ?? 0)}${COIN}</div><div class="k">Profit</div></div>
      <div class="tile searches"><div class="v">${fmt(stats?.searches ?? 0)}</div><div class="k">Searches</div></div>
      <div class="panelbox top-snipes"><h3>Top snipes</h3>${
        top.length === 0
          ? '<div class="empty" style="padding:6px">No snipes yet</div>'
          : top
              .map(
                (t) =>
                  `<div class="ts-row"><span>${esc(nameOf(t.assetId ?? t.resourceId))}</span><span>${fmt(t.profit ?? 0)}${COIN}</span></div>`,
              )
              .join('')
      }</div>
      <div class="counters">
        <div class="counter c-green"><span>Bought</span><span class="n">${fmt(stats?.purchases ?? 0)}</span></div>
        <div class="counter c-red"><span>Missed</span><span class="n">${fmt(stats?.failures ?? 0)}</span></div>
        <div class="counter c-blue"><span>Coins spent</span><span class="n">${fmt(stats?.coinsSpent ?? 0)}</span></div>
        <div class="counter c-yellow" title="Transfer list tracking is not available yet"><span>Sold</span><span class="n na">—</span></div>
        <div class="counter c-orange" title="Transfer list tracking is not available yet"><span>Unsold</span><span class="n na">—</span></div>
      </div>
      <div class="panelbox ring-box" id="ringbox"></div>
      <div class="panelbox tl" title="Transfer list tracking is not available yet">
        <div class="hd"><span>Transfer list</span></div>
        <div class="big na">— <span style="font-size:12px;font-weight:600">/100</span></div>
        <div class="bar"><i style="width:0%"></i></div>
      </div>
    `;
    renderRing();
  }

  function renderRing(): void {
    const box = root.getElementById('ringbox');
    if (!box) return;
    const sniper = deps.getSniper();
    const state = sniper?.state;
    const now = Date.now();
    const endsAt = state?.phaseEndsAt ?? null;
    const remaining = endsAt ? Math.max(0, endsAt - now) : 0;
    let fraction = 0;
    if (endsAt && remaining > 0) {
      const started =
        (box.dataset.endsAt === String(endsAt) ? Number(box.dataset.total) : remaining) ||
        remaining;
      box.dataset.endsAt = String(endsAt);
      box.dataset.total = String(started);
      fraction = remaining / started;
    }
    const secs = remaining / 1000;
    const label = remaining > 0 ? (secs >= 60 ? clock(remaining) : `${Math.ceil(secs)}s`) : '0s';
    const elapsed = sniper?.getStats().startedAt ? now - sniper.getStats().startedAt! : 0;
    const r = 56;
    const c = 2 * Math.PI * r;
    box.innerHTML = `
      <svg class="ring" viewBox="0 0 130 130" aria-hidden="true">
        <circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--ea-line)" stroke-width="7"/>
        <circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--ea-accent)" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - fraction)}" transform="rotate(-90 65 65)"/>
      </svg>
      <div class="ring-label"><div class="t">${esc(label)}</div><div class="p">${esc(PHASE_LABEL[state?.phase ?? 'idle'])}</div></div>
      <div class="elapsed">Running for<b>${clock(elapsed)}</b></div>`;
  }

  function logHtml(e: SniperLogEntry): string {
    const when = timeOfDay(e.at);
    if (e.kind === 'info')
      return `<div class="log"><div class="main">${esc(e.message)}<div class="sub">${when}</div></div></div>`;
    const who = `${e.rating ?? ''} ${esc(nameOf(e.assetId ?? e.resourceId))}`.trim();
    if (e.kind === 'bought') {
      const pill =
        e.profit == null
          ? ''
          : `<span class="pill ${e.profit < 0 ? 'neg' : ''}">${e.profit >= 0 ? '+' : ''}${fmt(e.profit)}${COIN}</span>`;
      return `<div class="log bought"><div class="main"><b>${who}</b> bought for ${fmt(e.price ?? 0)}${COIN}
        <div class="sub">${when}${e.sellPrice != null ? `, sells for ${fmt(e.sellPrice)}${COIN}` : ''}</div></div>${pill}</div>`;
    }
    if (e.kind === 'failed') {
      return `<div class="log failed"><div class="main">${e.resourceId != null ? `<b>${who}</b> missed at ${fmt(e.price ?? 0)}${COIN}` : esc(e.message)}
        <div class="sub">${when}${e.resourceId != null ? `, ${esc(e.message)}` : ''}</div></div></div>`;
    }
    return `<div class="log blocked"><div class="main">${esc(e.message)}<div class="sub">${when}</div></div></div>`;
  }

  function resultHtml(r: SniperSearchResult): string {
    const when = timeOfDay(r.at);
    if (r.matches.length === 0)
      return `<div class="res"><span class="when">${when}</span>No matches</div>`;
    const rows = r.matches
      .map(
        (m) =>
          `<div class="res item"><span>${m.rating} ${esc(nameOf(m.assetId))}</span><span>${fmt(m.buyNow)}${COIN}${
            m.expiresAt ? `, ${clock(m.expiresAt - r.at)} left` : ''
          }</span></div>`,
      )
      .join('');
    return `<div class="res"><span class="when">${when}</span>Found ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}</div>${rows}`;
  }

  function renderFeeds(): void {
    const sniper = deps.getSniper();
    const log = sniper?.getLog() ?? [];
    const results = sniper?.getSearchResults() ?? [];
    wantNames([
      ...log.map((e) => e.assetId ?? e.resourceId),
      ...results.flatMap((r) => r.matches.map((m) => m.assetId)),
    ]);
    $('log').innerHTML =
      log.length === 0
        ? '<div class="empty">Purchases and events appear here once Nova AI is running.</div>'
        : log.map(logHtml).join('');
    $('results').innerHTML =
      results.length === 0
        ? '<div class="empty">Each search appears here.</div>'
        : results.map(resultHtml).join('');
  }

  function renderTop(): void {
    const sniper = deps.getSniper();
    const state = sniper?.state;
    const running = sniper?.isRunning() ?? false;
    const phase = $('phase');
    phase.textContent =
      state?.phase === 'stopped' && state.stopDetail
        ? `Stopped: ${state.stopDetail}`
        : PHASE_LABEL[state?.phase ?? 'idle'];
    phase.className = `chip ${running ? 'running' : state?.phase === 'stopped' ? 'stopped' : ''}`;
    renderRunbar();
    $<HTMLButtonElement>('reset').disabled = !sniper || running;
    const notice = $('notice');
    notice.hidden = !!sniper;
    notice.textContent = deps.getUnavailableReason() ?? '';
  }

  function refreshLive(): void {
    renderTop();
    renderDash();
    renderFeeds();
  }

  function queueRefresh(): void {
    if (refreshQueued || page.hidden) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refreshLive();
    });
  }

  onTrusted($('start'), 'click', () => {
    const sniper = deps.getSniper();
    if (!sniper) return;
    if (sniper.isRunning()) sniper.stop('manual');
    else if (ackNeeded()) {
      say('Confirm the risk level (or reset to recommended) to start');
      return;
    } else {
      const r = currentSearch();
      if ('error' in r) {
        say(r.error);
        renderRunbar();
        return;
      }
      deps.setLiveSearch(r.search);
      sniper.setSettings(settings);
      sniper.start();
    }
    refreshLive();
  });
  onTrusted($('reset'), 'click', () => {
    deps.getSniper()?.reset();
    refreshLive();
  });
  onTrusted($('close'), 'click', () => api.close());
  // Esc closes the page from anywhere on EA's page, like the nav item does.
  // An open list inside the page takes the first Esc (the search's keydown
  // handler stops it there).
  onTrusted(doc, 'keydown', (e) => {
    if (e.key === 'Escape' && !page.hidden) api.close();
  });

  const api: BotPage = {
    open() {
      if (!page.hidden) return;
      settings = deps.getSettings();
      pending = null;
      renderSettings();
      page.hidden = false;
      refreshLive();
      void deps.prepare().then(() => {
        if (!page.hidden) refreshLive();
      });
      loadCatalog();
      // EA's lists arrive in two steps (files, then the web app's own lists
      // once it has started); pick each one up while the page is open.
      catalogPoll = setInterval(loadCatalog, 3_000);
      tick = setInterval(() => {
        renderRing();
        if (deps.getSniper()?.isRunning()) renderTop();
      }, 250);
      openListeners.forEach((cb) => cb(true));
    },
    close() {
      if (page.hidden) return;
      page.hidden = true;
      if (tick) clearInterval(tick);
      if (catalogPoll) clearInterval(catalogPoll);
      catalogPoll = null;
      tick = null;
      openListeners.forEach((cb) => cb(false));
    },
    toggle() {
      if (page.hidden) api.open();
      else api.close();
    },
    isOpen: () => !page.hidden,
    refresh: queueRefresh,
    setBounds({ left, top, right, bottom }) {
      const px = (n: number) => `${Math.max(0, Math.round(n))}px`;
      page.style.setProperty('--left', px(left));
      page.style.setProperty('--top', px(top));
      page.style.setProperty('--right', px(right));
      page.style.setProperty('--bottom', px(bottom));
    },
    onOpenChange(cb) {
      openListeners.add(cb);
    },
  };

  return api;
}
