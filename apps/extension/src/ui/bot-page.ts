/*
 * bot-page.ts — the Sniping Bot page: a full-height page over EA's content
 * area, opened from the "Sniping Bot" item this extension adds to EA's left
 * navigation (`ui/ea-nav.ts`) or from the in-page panel.
 *
 * Left: the settings the bot runs on (filters, delay, breaks, rest,
 * thresholds, safety limits), saved as the user edits. Right: the live
 * session — profit, searches, top snipes, the countdown to the next action,
 * counters, the bot log and search results.
 *
 * Every limit is the user's call. Presets range from Safe to Risky and the
 * fields accept anything inside `BOT_LIMITS` (checked by `botSettingsSchema`
 * before saving); the page only labels how risky the current pacing is.
 *
 * Renders in its own shadow root; EA's styles cannot reach in. All text
 * that comes from data (filter names, card names, error messages) goes
 * through `esc()`.
 */
import {
  SAFETY_PRESETS,
  SEARCH_DELAY_PRESETS,
  botRiskLevel,
  botSettingsSchema,
  estimatedSearchesPerHour,
  type BotSettings,
  type FilterCriteria,
  type SafetyPresetKey,
  type SavedFilter,
} from '@sl/shared';

import {
  POSITIONS,
  QUALITIES,
  searchPlayers,
  type Catalog,
  type CatalogEntry,
  type CatalogPlayer,
} from '../model/catalog.js';

import type { Sniper, SniperLogEntry, SniperPhase, SniperSearchResult } from '../engine/sniper.js';

export interface BotPageDeps {
  /** The bot, once it can run; null while signed out or on a plan without it. */
  getSniper: () => Sniper | null;
  /** Why the bot cannot run, when `getSniper()` is null. */
  getUnavailableReason: () => string | null;
  /** Re-checks sign-in and plan (creating the bot if they now allow it).
   * Called whenever the page opens, so signing in from the SL drawer does
   * not need a page reload. */
  prepare: () => Promise<void>;
  getSettings: () => BotSettings;
  saveSettings: (settings: BotSettings) => Promise<void>;
  getFilters: () => SavedFilter[];
  saveFilters: (filters: SavedFilter[]) => Promise<void>;
  resolveNames: (resourceIds: number[]) => Promise<Record<string, string | null>>;
  /** EA's player/club/league/nation lists, if the web app has loaded them
   * since the extension was installed (model/catalog.ts). */
  getCatalog: () => Promise<Catalog | null>;
}

export interface BotPage {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-render the live side (call when the sniper changes). */
  refresh(): void;
  /** Keep the page clear of EA's left navigation and top bar. */
  setOffsets(leftPx: number, topPx: number): void;
  onOpenChange(cb: (open: boolean) => void): void;
}

const COIN = `<svg class="coin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#f5c542"/><circle cx="8" cy="8" r="4.6" fill="none" stroke="#b8860b" stroke-width="1.4"/></svg>`;

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
  waiting: 'Next search',
  break: 'On a break',
  rest: 'Resting',
  blocked: 'Paused by safety limits',
  stopped: 'Stopped',
};

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .page {
    position: fixed; top: var(--top, 0px); right: 0; bottom: 0; left: var(--left, 0px); z-index: 2147482000;
    display: flex; flex-direction: column; background: #16181d; color: #e8eaed;
    font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .page[hidden] { display: none; }
  .coin { width: 14px; height: 14px; vertical-align: -2px; margin-left: 3px; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }

  .top { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid #262a33; }
  .top h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: .2px; }
  .chip { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #262a33; color: #aab0bb; }
  .chip.running { background: rgba(34,197,94,.15); color: #4ade80; }
  .chip.stopped { background: rgba(239,68,68,.15); color: #f87171; }
  .spacer { flex: 1; }
  .risk { padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; letter-spacing: .5px; }
  .risk.low { background: rgba(34,197,94,.18); color: #4ade80; }
  .risk.medium { background: rgba(245,158,11,.18); color: #fbbf24; }
  .risk.high { background: rgba(239,68,68,.18); color: #f87171; }
  .start { border: 0; border-radius: 8px; padding: 9px 22px; font-weight: 700; background: #1d9bf0; color: #fff; }
  .start.stop { background: #ef4444; }
  .start:disabled { opacity: .45; cursor: not-allowed; }
  .ghost { border: 1px solid #333844; background: none; border-radius: 8px; padding: 8px 12px; color: #aab0bb; }
  .close { border: 0; background: none; font-size: 20px; line-height: 1; color: #8b919c; padding: 4px 8px; }
  .notice { margin: 10px 18px 0; padding: 10px 12px; border-radius: 8px; background: rgba(245,158,11,.12); color: #fbbf24; }
  .notice[hidden] { display: none; }

  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(360px, 44%) 1fr; }
  .settings { overflow-y: auto; padding: 14px 16px 60px; border-right: 1px solid #262a33; }
  .live { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 10px; padding: 12px; overflow: hidden; }

  .card { background: #1e2129; border-radius: 12px; margin-bottom: 12px; }
  .card > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; font-size: 17px; font-weight: 700; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary .chev { margin-left: auto; color: #8b919c; transition: transform .15s; }
  .card[open] > summary .chev { transform: rotate(180deg); }
  .card .inner { padding: 0 16px 14px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .row + .row { border-top: 1px solid #262a33; }
  .row .label { flex: 1; min-width: 0; }
  .row .label b { display: block; font-weight: 600; }
  .row .label span { color: #8b919c; font-size: 12px; }
  .stepper { display: flex; align-items: center; gap: 6px; border: 1px solid #333844; border-radius: 10px; padding: 4px 6px; background: #181b22; }
  .stepper button { width: 24px; height: 24px; border: 0; border-radius: 6px; background: none; color: #aab0bb; font-size: 16px; }
  .stepper button:hover { background: #262a33; }
  .stepper input { width: 70px; border: 0; background: none; color: #e8eaed; text-align: center; font-size: 15px; font-weight: 600; }
  .stepper input.wide { width: 110px; }
  .stepper .unit { color: #8b919c; font-size: 12px; min-width: 34px; }
  .stepper input[aria-invalid='true'] { color: #f87171; }
  .presets { display: flex; gap: 6px; justify-content: flex-end; padding-top: 6px; }
  .preset { border: 1px solid #333844; background: #181b22; border-radius: 8px; padding: 4px 10px; text-align: center; min-width: 58px; }
  .preset b { display: block; font-size: 13px; }
  .preset small { display: inline-block; margin-top: 2px; padding: 0 6px; border-radius: 4px; font-size: 10px; font-weight: 800; }
  .preset[aria-pressed='true'] { border-color: #f59e0b; background: rgba(245,158,11,.1); }
  .tag-risky { background: rgba(239,68,68,.2); color: #f87171; }
  .tag-medium { background: rgba(245,158,11,.2); color: #fbbf24; }
  .tag-safe { background: rgba(34,197,94,.2); color: #4ade80; }
  .toggle { position: relative; width: 38px; height: 22px; border-radius: 999px; border: 0; background: #3a3f4b; flex: none; }
  .toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
  .toggle[aria-checked='true'] { background: #22c55e; }
  .toggle[aria-checked='true']::after { left: 19px; }
  .badge-rec { padding: 3px 8px; border-radius: 6px; background: rgba(34,197,94,.18); color: #4ade80; font-size: 11px; font-weight: 800; }
  .hint { color: #8b919c; font-size: 12px; padding-top: 6px; }
  .warn { color: #fbbf24; font-size: 12px; padding-top: 6px; }
  .saved { color: #4ade80; font-size: 12px; min-width: 60px; }
  .filters { display: grid; gap: 6px; }
  .filter { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: #181b22; }
  .filter .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .filter .meta { color: #8b919c; font-size: 12px; }
  .filter button { border: 0; background: none; color: #8b919c; font-size: 16px; }
  .addf { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding-top: 8px; }
  .addf input { width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid #333844; background: #181b22; color: #e8eaed; }
  .addf .full { grid-column: 1 / -1; }
  .addf select { width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid #333844; background: #181b22; color: #e8eaed; }
  .addf input[aria-invalid='true'] { border-color: #f87171; }
  .addf button.add { grid-column: 1 / -1; border: 0; border-radius: 8px; padding: 9px; background: #1d9bf0; color: #fff; font-weight: 700; }
  .addf .lbl { grid-column: 1 / -1; color: #8b919c; font-size: 11px; font-weight: 700; letter-spacing: .4px; margin-top: 4px; }
  .combo { position: relative; }
  .suggest { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; max-height: 260px; overflow-y: auto;
    background: #20242d; border: 1px solid #333844; border-radius: 8px; box-shadow: 0 10px 24px rgba(0,0,0,.5); }
  .suggest[hidden] { display: none; }
  .suggest button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 8px 10px; border: 0; background: none; text-align: left; }
  .suggest button:hover, .suggest button.active { background: #2a2f3a; }
  .suggest .r { min-width: 26px; font-weight: 800; color: #f5c542; }
  .picked { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; background: rgba(29,155,240,.12); border: 1px solid #1d9bf0; }
  .picked b { flex: 1; }
  .picked button { border: 0; background: none; color: #8b919c; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .chips span { padding: 1px 6px; border-radius: 4px; background: #262a33; color: #aab0bb; font-size: 11px; }

  .dash { display: grid; grid-template-columns: 1fr 0.9fr 1.3fr 1.2fr; grid-template-rows: auto auto; gap: 10px; }
  .tile { border-radius: 12px; padding: 12px; display: flex; flex-direction: column; justify-content: center; }
  .tile .v { font-size: 22px; font-weight: 800; display: flex; align-items: center; }
  .tile .k { font-size: 11px; opacity: .9; }
  .tile.profit { background: #1d9bf0; color: #fff; }
  .tile.searches { background: #22b14c; color: #fff; align-items: center; }
  .panelbox { background: #1e2129; border-radius: 12px; padding: 10px 12px; }
  .top-snipes { grid-row: span 1; }
  .top-snipes h3 { margin: 0 0 6px; text-align: center; font-style: italic; font-size: 16px; font-weight: 800; }
  .ts-row { display: flex; justify-content: space-between; color: #aab0bb; font-size: 12px; }
  .ts-row:first-of-type { color: #fff; font-size: 15px; font-weight: 700; }
  .counters { grid-row: span 2; display: grid; gap: 6px; }
  .counter { display: flex; align-items: center; justify-content: space-between; padding: 9px 10px; border-radius: 8px; background: #1e2129; border-left: 3px solid; font-weight: 600; }
  .counter .n { font-size: 15px; }
  .c-green { border-color: #22c55e; } .c-red { border-color: #ef4444; } .c-blue { border-color: #3b82f6; }
  .c-yellow { border-color: #eab308; } .c-orange { border-color: #f97316; }
  .ring-box { grid-column: span 2; display: flex; align-items: center; justify-content: center; position: relative; min-height: 150px; }
  .ring { width: 130px; height: 130px; }
  .ring-label { position: absolute; text-align: center; }
  .ring-label .t { font-size: 30px; font-style: italic; font-weight: 800; }
  .ring-label .p { font-size: 11px; color: #8b919c; }
  .elapsed { position: absolute; left: 12px; bottom: 8px; font-size: 11px; color: #8b919c; }
  .elapsed b { display: block; color: #e8eaed; font-size: 14px; }
  .tl .hd { display: flex; justify-content: space-between; color: #aab0bb; font-size: 12px; }
  .tl .big { font-size: 18px; font-weight: 800; margin-top: 4px; }
  .bar { height: 6px; border-radius: 3px; background: #262a33; margin-top: 6px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #22c55e; }

  .feeds { min-height: 0; display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; }
  .feed { min-height: 0; display: flex; flex-direction: column; background: #1e2129; border-radius: 12px; overflow: hidden; }
  .feed h4 { margin: 0; padding: 8px 12px; font-size: 13px; font-style: italic; font-weight: 800; border-bottom: 1px solid #262a33; letter-spacing: .3px; }
  .feed .list { flex: 1; overflow-y: auto; padding: 6px; }
  .log { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; background: #181b22; border-left: 3px solid #3a3f4b; }
  .log.bought { border-color: #22c55e; } .log.failed { border-color: #ef4444; } .log.blocked { border-color: #f59e0b; }
  .log .main { flex: 1; min-width: 0; }
  .log .main b { font-weight: 700; }
  .log .sub { color: #8b919c; font-size: 11px; }
  .pill { padding: 5px 10px; border-radius: 8px; font-weight: 800; background: rgba(34,197,94,.15); color: #4ade80; white-space: nowrap; }
  .pill.neg { background: rgba(239,68,68,.15); color: #f87171; }
  .res { font-size: 12px; padding: 2px 6px; }
  .res .when { color: #8b919c; margin-right: 6px; }
  .res.item { display: flex; justify-content: space-between; color: #e8eaed; background: #181b22; border-radius: 4px; margin: 2px 0; }
  .empty { color: #8b919c; padding: 16px; text-align: center; }
  .na { color: #6b7280; }

  @media (max-width: 1100px) {
    .body { grid-template-columns: 1fr; overflow-y: auto; }
    .settings { overflow: visible; border-right: 0; }
    .live { overflow: visible; }
    .dash { grid-template-columns: 1fr 1fr; }
    .counters, .ring-box { grid-column: span 2; grid-row: auto; }
    .feeds { grid-template-columns: 1fr; }
  }
`;

export function createBotPage(deps: BotPageDeps, doc: Document = document): BotPage {
  const host = doc.createElement('div');
  host.id = 'ledger-bot-page';
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const page = doc.createElement('div');
  page.className = 'page';
  page.hidden = true;
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Sniping Bot');
  root.append(style, page);
  (doc.body || doc.documentElement).appendChild(host);

  const names = new Map<number, string | null>();
  const openListeners = new Set<(open: boolean) => void>();
  let settings = deps.getSettings();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let refreshQueued = false;
  let catalog: Catalog | null = null;
  let picked: CatalogPlayer | null = null;
  let suggestions: CatalogPlayer[] = [];

  page.innerHTML = `
    <div class="top">
      <h1>Sniping Bot</h1>
      <span class="chip" id="phase">Ready</span>
      <span class="risk" id="risk"></span>
      <span class="spacer"></span>
      <span class="saved" id="saved" aria-live="polite"></span>
      <button class="ghost" id="reset" type="button">Reset stats</button>
      <button class="start" id="start" type="button">Start</button>
      <button class="close" id="close" type="button" aria-label="Close the Sniping Bot page">✕</button>
    </div>
    <div class="notice" id="notice" hidden></div>
    <div class="body">
      <div class="settings" id="settings"><div id="targets"></div><div id="knobs"></div></div>
      <div class="live">
        <div class="dash" id="dash"></div>
        <div class="feeds">
          <section class="feed" aria-label="Sniping bot log"><h4>SNIPING BOT LOG</h4><div class="list" id="log"></div></section>
          <section class="feed" aria-label="Search results"><h4>SEARCH RESULTS</h4><div class="list" id="results"></div></section>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => root.getElementById(id) as T;

  // ---- settings column ----------------------------------------------------

  function stepper(id: string, value: string, unit: string, wide = false): string {
    return `<div class="stepper"><button type="button" data-step="${id}" data-dir="-1" aria-label="Decrease">−</button>
      <input id="${id}" value="${esc(value)}" inputmode="decimal" class="${wide ? 'wide' : ''}" aria-label="${esc(unit)}" />
      <span class="unit">${esc(unit)}</span>
      <button type="button" data-step="${id}" data-dir="1" aria-label="Increase">+</button></div>`;
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

  function renderKnobs(): void {
    const s = settings;
    const delayPreset = SEARCH_DELAY_PRESETS.find(
      (p) => p.min === s.searchDelay.min && p.max === s.searchDelay.max,
    )?.key;
    const safetyPreset = (Object.keys(SAFETY_PRESETS) as SafetyPresetKey[]).find((k) =>
      Object.entries(SAFETY_PRESETS[k]).every(
        ([f, v]) => s.safety[f as keyof BotSettings['safety']] === v,
      ),
    );

    $('knobs').innerHTML =
      section(
        'Delay Settings',
        `<div class="row"><div class="label"><b>Search Delay Time</b><span>Delay between searches (seconds)</span></div>
          ${stepper('delay', rangeText(s.searchDelay), 'secs')}</div>
        <div class="presets">${SEARCH_DELAY_PRESETS.map(
          (
            p,
          ) => `<button type="button" class="preset" data-delay="${p.key}" aria-pressed="${delayPreset === p.key}">
            <b>${p.min}-${p.max}</b><small class="tag-${p.key}">${p.label.toUpperCase()}</small></button>`,
        ).join('')}</div>`,
      ) +
      section(
        'Break Settings',
        `<div class="row"><div class="label"><b>Searches Between Breaks</b><span>Number of searches between taking breaks</span></div>
          ${stepper('b-searches', rangeText(s.breaks.searches), 'searches')}</div>
        <div class="row"><div class="label"><b>Break Duration</b><span>Duration of the break (seconds)</span></div>
          ${stepper('b-seconds', rangeText(s.breaks.seconds), 'secs')}</div>`,
        `&nbsp;${toggle('b-on', s.breaks.enabled, 'Take breaks')}`,
      ) +
      section(
        'Rest Settings',
        `<div class="row"><div class="label"><b>Minutes Before Rest</b><span>Number of minutes before taking a rest</span></div>
          ${stepper('r-after', rangeText(s.rest.afterMinutes), 'mins', true)}</div>
        <div class="row"><div class="label"><b>Rest Duration</b><span>Duration of the rest (minutes)</span></div>
          ${stepper('r-minutes', rangeText(s.rest.minutes), 'mins', true)}</div>
        <div class="hint">Type one number (30) or a range (20-30) — the bot picks a random value inside it each time.</div>`,
        `&nbsp;<span class="badge-rec">RECOMMENDED</span>${toggle('r-on', s.rest.enabled, 'Take rests')}`,
      ) +
      section(
        'Thresholds',
        `<div class="row"><div class="label"><b>Max Buy Price</b><span>Never pay more than this. 0 = each target's own max price</span></div>
          ${stepper('t-max', String(s.thresholds.maxBuyPrice), 'coins', true)}</div>
        <div class="row"><div class="label"><b>Min Profit</b><span>Skip listings with a known profit below this (after 5% tax). 0 = off</span></div>
          ${stepper('t-profit', String(s.thresholds.minProfit), 'coins', true)}</div>
        <div class="row"><div class="label"><b>Stop After Purchases</b><span>0 = no limit</span></div>
          ${stepper('t-buys', String(s.thresholds.stopAfterPurchases), 'buys')}</div>
        <div class="row"><div class="label"><b>Coin Budget</b><span>Stop once this much is spent. 0 = no limit</span></div>
          ${stepper('t-budget', String(s.thresholds.sessionCoinBudget), 'coins', true)}</div>`,
        '',
        false,
      ) +
      section(
        'Safety Limits',
        `<div class="presets" style="justify-content:flex-start;padding:0 0 6px">${(
          ['low', 'medium', 'high'] as const
        )
          .map(
            (
              k,
            ) => `<button type="button" class="preset" data-safety="${k}" aria-pressed="${safetyPreset === k}">
              <b>${k === 'low' ? 'Low' : k === 'medium' ? 'Medium' : 'High'}</b><small class="tag-${k === 'low' ? 'safe' : k === 'medium' ? 'medium' : 'risky'}">${k.toUpperCase()} RISK</small></button>`,
          )
          .join('')}</div>
        <div class="row"><div class="label"><b>Actions Per Hour</b><span>Searches + buys in any hour before the bot cools down</span></div>
          ${stepper('s-aph', String(s.safety.actionsPerHour), '/hour')}</div>
        <div class="row"><div class="label"><b>Session Length</b><span>The bot stops after this long</span></div>
          ${stepper('s-session', String(s.safety.sessionLengthMinutes), 'mins')}</div>
        <div class="row"><div class="label"><b>Buys Per Search</b><span>Most buys allowed per search made (0.01–1)</span></div>
          ${stepper('s-ratio', String(s.safety.buyToSearchRatio), 'ratio')}</div>
        <div class="row"><div class="label"><b>Cooldown</b><span>Pause when a limit is hit</span></div>
          ${stepper('s-cooldown', String(s.safety.cooldownSeconds), 'secs')}</div>
        <div class="row"><div class="label"><b>Max Coins Per Hour</b><span>Spending cap over any hour</span></div>
          ${stepper('s-flow', String(s.safety.maxCoinFlowPerHour), 'coins', true)}</div>
        <div class="hint" id="pace"></div>`,
        '',
        false,
      );
    renderRisk();
  }

  // ---- Snipe Targets: EA-style search ---------------------------------------

  const byId = (list: CatalogEntry[]) => new Map(list.map((e) => [e.id, e.name]));

  function describeFilter(f: FilterCriteria): string[] {
    const names = {
      club: byId(catalog?.clubs ?? []),
      league: byId(catalog?.leagues ?? []),
      nation: byId(catalog?.nations ?? []),
    };
    const chips: string[] = [];
    if (f.resourceId != null) {
      const p = catalog?.players.find((x) => x.id === f.resourceId);
      chips.push(p ? `${p.rating ?? ''} ${p.name}`.trim() : `Player #${f.resourceId}`);
    }
    if (f.quality) chips.push(QUALITIES.find((q) => q.key === f.quality)?.label ?? f.quality);
    if (f.position) chips.push(f.position);
    if (f.nationality != null)
      chips.push(names.nation.get(f.nationality) ?? `Nation #${f.nationality}`);
    if (f.league != null) chips.push(names.league.get(f.league) ?? `League #${f.league}`);
    if (f.club != null) chips.push(names.club.get(f.club) ?? `Club #${f.club}`);
    if (f.minRating != null || f.maxRating != null)
      chips.push(`Rating ${f.minRating ?? 0}–${f.maxRating ?? 99}`);
    chips.push(f.maxPrice != null ? `max ${fmt(f.maxPrice)}` : 'no max price');
    return chips;
  }

  function datalist(id: string, list: CatalogEntry[]): string {
    return `<datalist id="${id}">${list.map((e) => `<option value="${esc(e.name)}"></option>`).join('')}</datalist>`;
  }

  function renderTargets(): void {
    const wasOpen = root.querySelector('#targets details')?.hasAttribute('open') ?? true;
    const filters = deps.getFilters();
    const hasPlayers = (catalog?.players.length ?? 0) > 0;
    const hasNames =
      (catalog?.leagues.length ?? 0) +
        (catalog?.nations.length ?? 0) +
        (catalog?.clubs.length ?? 0) >
      0;
    const catalogHint = hasPlayers
      ? `${fmt(catalog!.players.length)} players from EA's player list.`
      : "EA's player list isn't saved yet: open the web app's Transfer Market search once and it will be. Until then, type a player id.";

    $('targets').innerHTML = section(
      'Snipe Targets',
      `<div class="filters">${
        filters.length === 0
          ? '<div class="hint">No targets yet. Build a search below, like in the Transfer Market.</div>'
          : filters
              .map(
                (
                  f,
                ) => `<div class="filter"><div class="name" style="flex:1;min-width:0">${esc(f.name)}
                  <div class="chips">${describeFilter(f.filter)
                    .map((c) => `<span>${esc(c)}</span>`)
                    .join('')}</div></div>
                  <button type="button" data-remove="${esc(f.id)}" aria-label="Remove ${esc(f.name)}">✕</button></div>`,
              )
              .join('')
      }</div>
      <div class="addf" id="addf">
        <div class="lbl">PLAYER</div>
        <div class="full combo">${
          picked
            ? `<div class="picked"><span class="r">${picked.rating ?? ''}</span><b>${esc(picked.name)}</b>
                <button type="button" id="nf-unpick" aria-label="Clear player">✕</button></div>`
            : `<input id="nf-player" placeholder="${hasPlayers ? 'Search a player by name…' : 'Player id (optional)'}" autocomplete="off"
                role="combobox" aria-expanded="false" aria-controls="nf-suggest" aria-autocomplete="list" />
               <div class="suggest" id="nf-suggest" role="listbox" hidden></div>`
        }</div>
        <div class="lbl">FILTERS</div>
        <select id="nf-quality" aria-label="Quality"><option value="">Any quality</option>${QUALITIES.map((q) => `<option value="${q.key}">${q.label}</option>`).join('')}</select>
        <select id="nf-position" aria-label="Position"><option value="">Any position</option>${POSITIONS.map((p) => `<option>${p}</option>`).join('')}</select>
        <input id="nf-nation" list="dl-nations" placeholder="Nationality" autocomplete="off" aria-label="Nationality" />
        <input id="nf-league" list="dl-leagues" placeholder="League" autocomplete="off" aria-label="League" />
        <input class="full" id="nf-club" list="dl-clubs" placeholder="Club" autocomplete="off" aria-label="Club" />
        <input id="nf-minr" placeholder="Min rating" inputmode="numeric" aria-label="Min rating" />
        <input id="nf-maxr" placeholder="Max rating" inputmode="numeric" aria-label="Max rating" />
        <div class="lbl">PRICE</div>
        <input class="full" id="nf-max" placeholder="Max buy now price" inputmode="numeric" aria-label="Max buy now price" />
        <input class="full" id="nf-name" placeholder="Target name (optional)" maxlength="80" aria-label="Target name" />
        <button type="button" class="add" id="nf-add">Add target</button>
      </div>
      <div class="hint">${esc(catalogHint)}${hasNames ? '' : " Nationality, league and club need EA's names too, or type their EA id."}</div>
      ${datalist('dl-nations', catalog?.nations ?? [])}${datalist('dl-leagues', catalog?.leagues ?? [])}${datalist('dl-clubs', catalog?.clubs ?? [])}`,
      '',
      wasOpen,
    );
  }

  function showSuggestions(query: string): void {
    const box = root.getElementById('nf-suggest');
    const input = root.getElementById('nf-player');
    if (!box || !input) return;
    suggestions = catalog ? searchPlayers(catalog.players, query) : [];
    box.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(!box.hidden));
    box.innerHTML = suggestions
      .map(
        (p, i) =>
          `<button type="button" role="option" data-pick="${i}"><span class="r">${p.rating ?? ''}</span>${esc(p.name)}</button>`,
      )
      .join('');
  }

  function pick(p: CatalogPlayer): void {
    picked = p;
    suggestions = [];
    const keep = readForm();
    renderTargets();
    restoreForm(keep);
  }

  /** The add-target form's own fields, so re-rendering keeps what was typed. */
  function readForm(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of [
      'nf-quality',
      'nf-position',
      'nf-nation',
      'nf-league',
      'nf-club',
      'nf-minr',
      'nf-maxr',
      'nf-max',
      'nf-name',
    ]) {
      const el = root.getElementById(id) as HTMLInputElement | null;
      if (el) out[id] = el.value;
    }
    return out;
  }

  function restoreForm(values: Record<string, string>): void {
    for (const [id, v] of Object.entries(values)) {
      const el = root.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = v;
    }
  }

  $('targets').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player') showSuggestions(t.value);
  });
  $('targets').addEventListener('keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nf-player' && e.key === 'Enter' && suggestions[0]) {
      e.preventDefault();
      pick(suggestions[0]);
    }
  });

  function renderRisk(): void {
    const level = botRiskLevel(settings);
    const risk = $('risk');
    risk.className = `risk ${level}`;
    risk.textContent = `${level.toUpperCase()} RISK`;
    const perHour = estimatedSearchesPerHour(settings);
    const pace = root.getElementById('pace');
    if (pace) {
      pace.className = perHour > settings.safety.actionsPerHour ? 'warn' : 'hint';
      pace.textContent =
        perHour > settings.safety.actionsPerHour
          ? `This pace is about ${fmt(perHour)} searches an hour, above your ${fmt(settings.safety.actionsPerHour)} actions-per-hour limit — the bot will pause when it reaches the limit.`
          : `This pace is about ${fmt(perHour)} searches an hour. Faster is riskier: EA can flag or ban accounts that search non-stop.`;
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
    const s = settings;
    const next: BotSettings = {
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
        actionsPerHour: n('s-aph', s.safety.actionsPerHour),
        sessionLengthMinutes: n('s-session', s.safety.sessionLengthMinutes),
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
        'safety.actionsPerHour': 's-aph',
        'safety.sessionLengthMinutes': 's-session',
        'safety.buyToSearchRatio': 's-ratio',
        'safety.cooldownSeconds': 's-cooldown',
        'safety.maxCoinFlowPerHour': 's-flow',
      };
      const key = Object.keys(byPath).find((k) => path.startsWith(k));
      if (key) mark(byPath[key]!, false);
      $('saved').textContent = parsed.error.issues[0]?.message
        ? `Not saved: ${parsed.error.issues[0].message}`
        : 'Not saved';
      $('saved').style.color = '#f87171';
      return null;
    }
    return ok ? parsed.data : null;
  }

  function commit(next: BotSettings, rerender: boolean): void {
    settings = next;
    deps.getSniper()?.setSettings(next);
    if (rerender) renderKnobs();
    else renderRisk();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void deps.saveSettings(settings).then(() => {
        $('saved').style.color = '';
        $('saved').textContent = 'Saved';
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
    's-aph': 50,
    's-session': 15,
    's-ratio': 0.05,
    's-cooldown': 15,
    's-flow': 100_000,
  };

  $('settings').addEventListener('click', (e) => {
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
      const p = SEARCH_DELAY_PRESETS.find((x) => x.key === el.dataset.delay)!;
      commit({ ...settings, searchDelay: { min: p.min, max: p.max } }, true);
    } else if (el.dataset.safety) {
      commit(
        { ...settings, safety: { ...SAFETY_PRESETS[el.dataset.safety as SafetyPresetKey] } },
        true,
      );
    } else if (el.id === 'b-on') {
      commit(
        { ...settings, breaks: { ...settings.breaks, enabled: !settings.breaks.enabled } },
        true,
      );
    } else if (el.id === 'r-on') {
      commit({ ...settings, rest: { ...settings.rest, enabled: !settings.rest.enabled } }, true);
    } else if (el.dataset.remove) {
      const keep = readForm();
      void deps
        .saveFilters(deps.getFilters().filter((f) => f.id !== el.dataset.remove))
        .then(() => {
          renderTargets();
          restoreForm(keep);
        });
    } else if (el.dataset.pick) {
      const p = suggestions[Number(el.dataset.pick)];
      if (p) pick(p);
    } else if (el.id === 'nf-unpick') {
      picked = null;
      const keep = readForm();
      renderTargets();
      restoreForm(keep);
    } else if (el.id === 'nf-add') {
      void addFilter();
    }
    // A toggle or preset inside <summary> must not also fold the card.
    if (el.closest('summary')) e.preventDefault();
  });

  $('settings').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.id || input.id.startsWith('nf-')) return;
    const next = readSettings();
    if (next) commit(next, false);
  });

  async function addFilter(): Promise<void> {
    const field = (id: string) => root.getElementById(id) as HTMLInputElement | null;
    const v = (id: string) => field(id)?.value.trim() ?? '';
    let ok = true;
    const mark = (id: string, valid: boolean) => {
      field(id)?.setAttribute('aria-invalid', String(!valid));
      if (!valid) ok = false;
    };
    const int = (id: string, max?: number): number | undefined => {
      const raw = v(id).replace(/[,\s]/g, '');
      if (raw === '') return undefined;
      const n = Number(raw);
      const valid = Number.isInteger(n) && n >= 0 && (max == null || n <= max);
      mark(id, valid);
      return valid ? n : undefined;
    };
    /** A name picked from EA's list, or an EA id typed as a number. */
    const entry = (id: string, list: CatalogEntry[]): number | undefined => {
      const text = v(id);
      if (!text) return undefined;
      const hit = list.find((e) => e.name.toLowerCase() === text.toLowerCase());
      if (hit) return hit.id;
      const n = Number(text);
      const valid = Number.isInteger(n) && n > 0;
      mark(id, valid);
      return valid ? n : undefined;
    };

    const filter: FilterCriteria = {};
    if (picked) filter.resourceId = picked.id;
    else {
      const typed = v('nf-player');
      if (typed) {
        const n = Number(typed);
        if (Number.isInteger(n) && n > 0) filter.resourceId = n;
        else mark('nf-player', false);
      }
    }
    const quality = v('nf-quality');
    if (quality) filter.quality = quality as FilterCriteria['quality'];
    const position = v('nf-position');
    if (position) filter.position = position;
    const nation = entry('nf-nation', catalog?.nations ?? []);
    if (nation != null) filter.nationality = nation;
    const league = entry('nf-league', catalog?.leagues ?? []);
    if (league != null) filter.league = league;
    const club = entry('nf-club', catalog?.clubs ?? []);
    if (club != null) filter.club = club;
    const minR = int('nf-minr', 99);
    const maxR = int('nf-maxr', 99);
    if (minR != null) filter.minRating = minR;
    if (maxR != null) filter.maxRating = maxR;
    const max = int('nf-max');
    if (max != null) filter.maxPrice = max;

    const say = (text: string) => {
      $('saved').style.color = '#f87171';
      $('saved').textContent = text;
    };
    if (!ok) return say('Check the highlighted fields');
    if (Object.keys(filter).length === 0) return say('Pick a player or at least one filter');
    if (
      filter.minRating != null &&
      filter.maxRating != null &&
      filter.minRating > filter.maxRating
    ) {
      mark('nf-minr', false);
      return say('Min rating is above max rating');
    }

    const name = (v('nf-name') || describeFilter(filter).join(' · ')).slice(0, 80);
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(filter))),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const existing = deps.getFilters();
    const saved: SavedFilter = {
      id: crypto.randomUUID(),
      name,
      filter,
      filterHash: hash,
      isActive: true,
      sortOrder: existing.length,
      createdAt: new Date().toISOString(),
    };
    await deps.saveFilters([...existing, saved]);
    picked = null;
    renderTargets();
    $('saved').style.color = '';
    $('saved').textContent = 'Target added';
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
      <div class="panelbox top-snipes"><h3>TOP SNIPES</h3>${
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
        <div class="counter c-green"><span>Successful Purchases</span><span class="n">${fmt(stats?.purchases ?? 0)}</span></div>
        <div class="counter c-red"><span>Failed Purchases</span><span class="n">${fmt(stats?.failures ?? 0)}</span></div>
        <div class="counter c-blue"><span>Coins Spent</span><span class="n">${fmt(stats?.coinsSpent ?? 0)}</span></div>
        <div class="counter c-yellow" title="Transfer list tracking is not available yet"><span>Sold Items</span><span class="n na">—</span></div>
        <div class="counter c-orange" title="Transfer list tracking is not available yet"><span>Unsold Items</span><span class="n na">—</span></div>
      </div>
      <div class="panelbox ring-box" id="ringbox"></div>
      <div class="panelbox tl" title="Transfer list tracking is not available yet">
        <div class="hd"><span>Transfer List</span><span>↗</span></div>
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
        <circle cx="65" cy="65" r="${r}" fill="none" stroke="#2a2e38" stroke-width="7"/>
        <circle cx="65" cy="65" r="${r}" fill="none" stroke="#e8eaed" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - fraction)}" transform="rotate(-90 65 65)"/>
      </svg>
      <div class="ring-label"><div class="t">${esc(label)}</div><div class="p">${esc(PHASE_LABEL[state?.phase ?? 'idle'])}</div></div>
      <div class="elapsed">Time Elapsed<b>${clock(elapsed)}</b></div>`;
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
        <div class="sub">${when}${e.sellPrice != null ? ` · sell ${fmt(e.sellPrice)}${COIN}` : ''}</div></div>${pill}</div>`;
    }
    if (e.kind === 'failed') {
      return `<div class="log failed"><div class="main">${e.resourceId != null ? `<b>${who}</b> buy failed for ${fmt(e.price ?? 0)}${COIN}` : esc(e.message)}
        <div class="sub">${when}${e.resourceId != null ? ` · ${esc(e.message)}` : ''}</div></div></div>`;
    }
    return `<div class="log blocked"><div class="main">${esc(e.message)}<div class="sub">${when}</div></div></div>`;
  }

  function resultHtml(r: SniperSearchResult): string {
    const when = timeOfDay(r.at);
    if (r.matches.length === 0)
      return `<div class="res"><span class="when">${when}</span>No matches · ${esc(r.filterName)}</div>`;
    const rows = r.matches
      .map(
        (m) =>
          `<div class="res item"><span>${m.rating} ${esc(nameOf(m.assetId))}</span><span>${fmt(m.buyNow)}${COIN}${
            m.expiresAt ? ` · ${clock(m.expiresAt - r.at)}` : ''
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
        ? '<div class="empty">Purchases and events show up here.</div>'
        : log.map(logHtml).join('');
    $('results').innerHTML =
      results.length === 0
        ? '<div class="empty">Each search shows up here.</div>'
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
    const start = $<HTMLButtonElement>('start');
    start.textContent = running ? 'Stop' : 'Start';
    start.classList.toggle('stop', running);
    start.disabled = !sniper;
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

  $('start').addEventListener('click', () => {
    const sniper = deps.getSniper();
    if (!sniper) return;
    if (sniper.isRunning()) sniper.stop('manual');
    else {
      const next = readSettings();
      if (next) settings = next;
      sniper.setSettings(settings);
      sniper.start();
    }
    refreshLive();
  });
  $('reset').addEventListener('click', () => {
    deps.getSniper()?.reset();
    refreshLive();
  });
  $('close').addEventListener('click', () => api.close());
  page.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
  });

  const api: BotPage = {
    open() {
      if (!page.hidden) return;
      settings = deps.getSettings();
      renderSettings();
      page.hidden = false;
      refreshLive();
      void deps.prepare().then(() => {
        if (!page.hidden) refreshLive();
      });
      void deps.getCatalog().then((c) => {
        if (!c || page.hidden) return;
        catalog = c;
        const keep = readForm();
        renderTargets();
        restoreForm(keep);
      });
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
      tick = null;
      openListeners.forEach((cb) => cb(false));
    },
    toggle() {
      if (page.hidden) api.open();
      else api.close();
    },
    isOpen: () => !page.hidden,
    refresh: queueRefresh,
    setOffsets(leftPx, topPx) {
      page.style.setProperty('--left', `${Math.max(0, Math.round(leftPx))}px`);
      page.style.setProperty('--top', `${Math.max(0, Math.round(topPx))}px`);
    },
    onOpenChange(cb) {
      openListeners.add(cb);
    },
  };

  return api;
}
