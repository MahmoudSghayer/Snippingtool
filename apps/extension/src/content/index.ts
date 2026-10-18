/*
 * content/index.ts — the ISOLATED-world orchestrator. Owns the message bus
 * to both the MAIN-world adapter (via `adapter-client.ts`) and the service
 * worker (via `chrome.runtime` messages), and is the only place the engine
 * loop (ranker + governor + assist/autobuyer) actually runs — rule 5: the
 * service worker owns no loops, this file is where "loop" is allowed to
 * mean something.
 *
 * Also owns crash recovery: the governor's counters (and a little session
 * bookkeeping) are persisted on an interval and restored on load, so a page
 * reload within the same browser session resumes the risk budget instead of
 * quietly resetting it to zero (which would be a governor bypass, not a
 * convenience). The persistence itself goes through background
 * (`engine.stateSet` / `engine.stateGet`, backed by `storage.session`
 * there) — never the session storage API from this file: MV3 content
 * scripts are not a trusted context for it, the call throws, and a thrown
 * boot here used to take M1 recording down with it (docs/12-testing.md
 * "Defects found" row #10). Nothing in this file touches `lib/storage.ts`.
 *
 * Only one EA tab runs an engine at a time (P0 Task 13): the one holding
 * the per-profile engine lease (content/engine-lease.ts,
 * background/engine-lease.ts). Every other tab still records (M1), but its
 * assist chords, autobuyer and Sniping Bot do nothing, so two tabs can never
 * spend the hourly budgets twice.
 */
import {
  DEFAULT_ASSIST_HOTKEYS,
  DEFAULT_BOT_SETTINGS,
  extContentKillSwitchMessageSchema,
  extContentResetSessionMessageSchema,
} from '@sl/shared';
import browser from 'webextension-polyfill';

import { AssistEngine, activeFilterHandles } from '../engine/assist.js';
import { Governor, type GovernorState } from '../engine/governor.js';
import { rankCandidates, type ScoredOpportunity } from '../engine/ranker.js';
import { countObservedSearches, governedSearch } from '../engine/search.js';
import { attemptErrorCode, attemptTiming } from '../engine/types.js';
import { handOffWasLate, readHandedOffNonce } from '../lib/act-auth.js';
import { createBackgroundTimer } from '../lib/background-timer.js';
import { riskLevelChangeEvent } from '../lib/bot-safety.js';
import { createLogThrottle, droppedSuffix } from '../lib/log-throttle.js';
import { logger } from '../lib/logger.js';
import { PILE_MIN_GAP_MS, createPileRefresher } from '../lib/pile-refresh.js';
import { singleFlight } from '../lib/single-flight.js';
import { buildBoughtTrade } from '../lib/trade-report.js';
import { createTransferListTracker } from '../lib/transfer-list.js';
import { createBotPage, type LiveSearch } from '../ui/bot-page.js';
import { createConfirmOverlay, type ConfirmOverlay } from '../ui/confirm-overlay.js';
import { installNavItem } from '../ui/ea-nav.js';

import { createAdapterClient, pageWindow } from './adapter-client.js';
import { confirmDetailsFor, installAssistHotkeys, selectionDetailsFor } from './assist-keys.js';
import { createBackgroundClient } from './background-request.js';
import { currentCandidates } from './candidates.js';
import { createDiagnosticsResponder } from './diagnostics.js';
import { EngineLease, engineStateOf } from './engine-lease.js';
import { applySettingsToEngine, watchLiveSettings } from './live-settings.js';
import { createRecentSearchesSync } from './recent-searches.js';
import { createSearchObserver } from './search-observer.js';
import { createWatchdog } from './watchdog.js';

import type { Autobuyer, StopReason } from '../engine/autobuyer.js';
import type { Sniper } from '../engine/sniper.js';
import type { AttemptInput, TradeInput } from '../engine/types.js';
import type { Catalog } from '../model/catalog.js';
import type { PriceSummary } from '../model/prices.js';
import type {
  ActivityEvent,
  AdapterEaError,
  BotBudgetState,
  BotDailyUsage,
  BotSettings,
  BootstrapResponse,
  FeatureKey,
  RiskBudgetEvent,
  SavedFilter,
  SnipingAttempt,
  Trade,
  TradePileItem,
  TrimmedAuction,
  UserSettings,
} from '@sl/shared';

const AUTOMATION_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

const RECORD_FLUSH_MS = 2000;
const RECORD_FLUSH_AT = 300;
const STATE_PERSIST_MS = 5000;
const AUTOBUYER_TICK_MS = 8000;
const WATCHDOG_MS = 15000;
const WATCHDOG_STALE_MS = 60000;
/** The watchdog's allowance in a hidden tab, where Chrome runs both worlds'
 * timers about once a minute (content/watchdog.ts). */
const WATCHDOG_HIDDEN_STALE_MS = 5 * 60_000;
/** At most one log line (so one server error report, lib/errors.ts) per
 * kind of EA error or shape change in this long: while EA rate-limits the
 * account, the same error comes back on every search. */
const ADAPTER_WARN_GAP_MS = 10 * 60_000;
/** A failing probe this soon after the page loaded only means EA's web app
 * has not built its service layer yet (it does after login); the adapter
 * reports the real verdict once it passes, or after 10 minutes. */
const PROBE_STARTUP_GRACE_MS = 2 * 60_000;
/** How often a running Sniping Bot re-reads the entitlement (background's
 * cached `license.bootstrap`, refreshed by its heartbeat), so a plan that
 * loses the bot stops it mid-session. */
const ENTITLEMENT_CHECK_MS = 30000;
/** How often features and the kill switch are re-read from background's
 * cached entitlement (refreshed by its heartbeat), so a plan change reaches
 * an open tab without a reload (settings arrive by `storage.onChanged`). */
const LIVE_TICK_MS = 30000;
/** How often the engine lease is renewed (background/engine-lease.ts's
 * `ENGINE_LEASE_RENEW_MS`; a lease lasts three minutes). */
const LEASE_RENEW_MS = 20000;

// ---- background messaging ---------------------------------------------------

// `send` answers null for "no data" whatever the reason; `bg.request` and
// `bg.requireAnswer` tell a dead service worker apart from an answer, for
// the callers where that matters (content/background-request.ts).
const bg = createBackgroundClient(
  (message) => browser.runtime.sendMessage(message),
  (message) => logger.warn(message, 'content'),
);
const send = bg.send;

function nowIso(): string {
  return new Date().toISOString();
}

// ---- boot --------------------------------------------------------------------

async function main(): Promise<void> {
  // The act-channel nonce content/handoff.ts minted at document_start (the
  // userscript's setup.ts, in that build). Without it every act call fails
  // closed (assist/automation cannot buy); M1 recording does not need it.
  const actNonce = readHandedOffNonce();
  if (!actNonce) logger.warn('no act-channel nonce was handed off — assist/automation buys are disabled on this page', 'adapter');
  else if (handOffWasLate())
    logger.warn('the act-channel nonce was handed off after page scripts may have run (late userscript injection)', 'adapter');
  const adapter = createAdapterClient(pageWindow(), actNonce);
  // The options page's "Copy diagnostics" (content/diagnostics.ts). Wired
  // here, before any bootstrap, so it answers even when M2/M3 never boots —
  // which is exactly when it is needed.
  const respondToDiagnostics = createDiagnosticsResponder(adapter, browser.runtime.id);
  browser.runtime.onMessage.addListener((message: unknown, sender: { id?: string }) => respondToDiagnostics(message, sender));

  // The Snipe Targets form's choices, built by the adapter with the web
  // app's own lists once it has started (model/catalog.ts), and sent over
  // the same authenticated channel as act results: only a catalog whose MAC
  // verifies reaches this callback. Asked for now too, in case it was ready
  // before this script was listening.
  // Automation builds only: the listable build has no Sniping Bot page, and
  // its adapter builds no catalog.
  if (AUTOMATION_ENABLED) {
    adapter.onCatalog((catalog) => {
      void send('catalog.save', catalog);
    });
    adapter.requestCatalog();
  }

  // ---- M1: passive observation (always on, no account required) -----------

  let recordQueue: TrimmedAuction[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResourceId: number | null = null;
  const tracked = new Map<string, TrimmedAuction>();

  // Engine bindings are declared *here*, before any adapter callback is
  // registered, and only ever assigned further down once the account-gated
  // M2/M3 bootstrap has finished. `adapter.onAuctions` (M1 recording) and
  // `engineHealthState()` read them on every observation — if they were
  // `const`s declared after that bootstrap's `await`s, an observation
  // arriving before (or a bootstrap failure preventing) their initialisation
  // would throw a temporal-dead-zone ReferenceError from inside the
  // callback and silently kill recording + telemetry for the whole page
  // (docs/12-testing.md "Defects found" row #10). M1 never depends on M2
  // having booted.
  let governor: Governor | null = null;
  let assist: AssistEngine | null = null;
  // Server kill switch, tracked here as well as inside the governor so
  // an `engine.killSwitch` push arriving before the M2 bootstrap finishes
  // is not lost (it is re-applied to the governor once one exists).
  let killSwitchActive = false;
  // The Sniping Bot (automation builds; see "M3: the Sniping Bot page"
  // below). Declared here so the kill switch above can stop it.
  let sniper: Sniper | null = null;
  // The engine lease (this file's header), created once the bootstrap below
  // knows there is an engine to run. Null: this tab runs none.
  let lease: EngineLease | null = null;
  // The current search's own listings (search-observer.ts): the only ones
  // the ranker, assist and the autobuyer see. Ranked by `rerank()` once the
  // engine is up (`engineReady`), on every search and every engine tick.
  let currentSearch: TrimmedAuction[] = [];
  let engineReady = false;
  const lastSummaryByResource = new Map<number, PriceSummary>();

  async function flushRecordQueue(): Promise<void> {
    flushTimer = null;
    if (recordQueue.length === 0) return;
    const batch = recordQueue;
    recordQueue = [];

    const result = await send('record', { auctions: batch });
    if (!result) logger.warn('recorded nothing — the extension background may have reloaded', 'record');
  }

  function scheduleFlush(): void {
    if (recordQueue.length >= RECORD_FLUSH_AT) {
      if (flushTimer) clearTimeout(flushTimer);
      void flushRecordQueue();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(() => void flushRecordQueue(), RECORD_FLUSH_MS);
  }

  function reportSearchActivity(filterHash: string, auctions: TrimmedAuction[]): void {
    const floorPrice = auctions.length ? Math.min(...auctions.map((a) => a.buyNow).filter((n) => n > 0)) : null;
    const event: ActivityEvent = {
      type: 'search',
      occurredAt: nowIso(),
      metadata: { filterHash, resourceId: lastResourceId ?? undefined, resultsCount: auctions.length, floorPrice: Number.isFinite(floorPrice) ? floorPrice : null },
    };
    void send('telemetry.enqueue', { kind: 'activity', items: [event] });
  }

  // Listings the adapter can now buy (it has seen their item entities).
  // Not a search: nothing is counted, recorded or reported.
  adapter.onBuyable((tradeIds) => {
    for (const tradeId of tradeIds) {
      const a = tracked.get(tradeId);
      if (a) tracked.set(tradeId, { ...a, buyable: true });
    }
  });

  // One `auctions` message is one search (the adapter posts each search
  // once, main/adapter.ts): content/search-observer.ts does the counting,
  // tracking, telemetry and ledger recording for it.
  adapter.onAuctions(
    createSearchObserver({
      tracked,
      onDominant: (resourceId) => {
        lastResourceId = resourceId;
      },
      reportSearch: reportSearchActivity,
      record: (auctions) => {
        recordQueue = recordQueue.concat(auctions);
        scheduleFlush();
      },
      onCurrentSearch: (auctions) => {
        currentSearch = auctions;
        if (!engineReady) return;
        // While the Sniping Bot runs it is the one engine buying (the
        // autobuyer waits for it too): nothing is offered from a ranking,
        // and no price lookups share the page with its searches and buys.
        if (sniper?.isRunning()) {
          rankedCandidates = [];
          assist?.cancelPending();
        } else void rerank();
      },
    }),
  );

  // Every observed search response counts toward the governor's
  // buy/search ratio and actionsPerHour — the human searching in EA's own UI
  // is what keeps assist-mode buys allowed (engine/search.ts). A no-op until
  // the bootstrap below has created a governor, and while the Sniping Bot
  // runs: its searches are its own governor's, and counting them here too
  // would spend assist's hourly budget on them. The unsubscribe is kept for
  // the page's teardown (`pagehide` below).
  const stopCountingSearches = countObservedSearches(adapter, () => (sniper?.isRunning() ? null : governor));

  // The trader's own trade pile (defect C13): background's trade lifecycle
  // links each item to the buy it came from and reports its sale once
  // (lib/trade-lifecycle.ts). The same responses keep the Nova AI page's
  // transfer list counts (lib/transfer-list.ts). Not a search: the governor
  // counts nothing for it. Forwarded first, so nothing in the page's counts
  // can keep the items from the lifecycle.
  const transferList = createTransferListTracker();
  // The coin balance EA's own answers state (main/adapter.ts), for the Nova
  // AI page's wallet.
  let eaCredits: { credits: number; at: number } | null = null;
  adapter.onCredits((credits) => {
    eaCredits = { credits, at: Date.now() };
  });
  adapter.onTradePile((items: TradePileItem[], full: boolean) => {
    void send('lifecycle.pile', { items, full });
    transferList.update(items, full);
  });

  let probeOk = true;
  // Reported once per failure, not on every act call that re-runs the
  // probe, and not while the web app is still starting: an adapter injected
  // after the page began loading (a late userscript) can report its very
  // first probe, from before EA built its service layer, to a content
  // script that is already listening.
  const bootedAt = Date.now();
  let probePassedOnce = false;
  let probeFailureReported: string | null = null;
  adapter.onProbe((status) => {
    probeOk = status.ok;
    if (status.ok) {
      probePassedOnce = true;
      probeFailureReported = null;
      return;
    }
    const reason = status.reason ?? 'unknown';
    if (reason === probeFailureReported) return;
    if (!probePassedOnce && Date.now() - bootedAt < PROBE_STARTUP_GRACE_MS) {
      logger.info(`bundle probe not passing yet (EA's web app may still be starting): ${reason}`, 'adapter.probe');
      return;
    }
    probeFailureReported = reason;
    logger.error(`bundle probe failed: ${reason}`, 'adapter.probe');
    void send('telemetry.enqueue', {
      kind: 'activity',
      items: [{ type: 'error', occurredAt: nowIso(), metadata: { code: 'ADAPTER_PROBE_FAILED', message: reason, context: 'adapter.probe' } }] satisfies ActivityEvent[],
    });
  });

  const throttleAdapterWarning = createLogThrottle(ADAPTER_WARN_GAP_MS);
  adapter.onShape((reason, endpoint) => {
    const dropped = throttleAdapterWarning(`shape:${endpoint}:${reason}`);
    if (dropped === null) return;
    // The trade pile only feeds the transfer list counts and the sale
    // tracking: nothing stops for it.
    if (endpoint === 'pile') logger.warn(`trade pile payload shape changed (nothing stops for it): ${reason.replace(/^trade pile: /, '')}${droppedSuffix(dropped)}`, 'adapter.shape');
    else logger.warn(`market payload shape changed: ${reason}${droppedSuffix(dropped)}`, 'adapter.shape');
  });

  // EA's own errors, as the adapter filed them (main/adapter.ts): never a
  // shape change. The Sniping Bot reacts to them itself (engine/sniper.ts).
  adapter.onEaError((error) => {
    const dropped = throttleAdapterWarning(`ea:${error.endpoint}:${error.category}`);
    if (dropped === null) return;
    const line = `EA answered HTTP ${error.status} to a ${EA_ENDPOINT_WORDS[error.endpoint]} (${error.category})${droppedSuffix(dropped)}`;
    // A refusal (someone else's buy got there first, say) is everyday
    // sniping, not a problem with the extension.
    if (error.category === 'rejected') logger.info(line, 'adapter.ea');
    else logger.warn(line, 'adapter.ea');
  });

  // engineHealthState()/engineHealthMessage() (a live status string for the
  // in-page panel) are gone with the panel itself (claude/bot-page-redesign).
  // ---- server kill switch: push (background -> this tab) + pull ------------
  //
  // Project rule 3 makes the kill switch unconditional, so it must reach an
  // engine that is already running, not just the next page load.
  // `background/kill-switch.ts` broadcasts `engine.killSwitch` to every open
  // EA tab after each bootstrap/heartbeat; `engineTick()` below also pulls
  // the cached flag (`license.killSwitchGet`, no network) every tick, so a
  // missed push is corrected within one tick.
  function applyKillSwitch(active: boolean, reason?: string): void {
    const changed = active !== killSwitchActive;
    killSwitchActive = active;
    governor?.setKillSwitch(active, active ? (reason ?? 'server kill switch active') : undefined);
    // The Sniping Bot runs its own governor: stop it now rather than at its
    // next action (it re-reads the switch before every one anyway).
    if (active && sniper?.isRunning()) sniper.stop('kill_switch', reason ?? 'server kill switch active');
    if (changed) {
      if (active) logger.warn(`kill switch active — ${reason ?? 'server kill switch active'}`, 'kill-switch');
      else logger.info('kill switch cleared by the server', 'kill-switch');
    }
  }

  browser.runtime.onMessage.addListener((message: unknown): undefined => {
    const parsed = extContentKillSwitchMessageSchema.safeParse(message);
    if (!parsed.success) return undefined; // not for us — another listener's
    applyKillSwitch(parsed.data.payload.active, parsed.data.payload.reason);
    return undefined;
  });

  // "New session" (engine.resetSession, passed on by background/
  // engine-lease.ts): the governor starts a new session — its clock and the
  // per-session buy/search/spend counts, never a cooldown, the hourly
  // windows or the kill switch (`Governor.resetSession`). Only the lease
  // holder acts and saves; another tab loads the result when it gains the
  // lease.
  function resetSession(): void {
    if (!governor || !lease?.isHeld()) return;
    governor.resetSession();
    assist?.resetSession();
    void persistState();
  }
  browser.runtime.onMessage.addListener((message: unknown): undefined => {
    if (!extContentResetSessionMessageSchema.safeParse(message).success) return undefined;
    resetSession();
    return undefined;
  });

  // ---- M2/M3: engine bootstrap (account required) --------------------------

  let settingsCache: UserSettings = (await send<UserSettings>('settings.get')) ?? {
    version: 0,
    targets: { minProfitPerSnipe: 1000, dailyProfitGoal: null },
    budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: null },
    governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 0.35, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
    telemetryOptOut: false,
    notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
  };

  const authStatus = await send<{ authenticated: boolean }>('auth.status');
  let features: FeatureKey[] = [];

  if (authStatus?.authenticated) {
    const bootstrap = await send<BootstrapResponse>('license.bootstrap');
    if (bootstrap) {
      features = bootstrap.features;
      // A push may already have arrived while this bootstrap was in flight;
      // an active switch from either source wins.
      killSwitchActive = killSwitchActive || bootstrap.killSwitchActive;
      settingsCache = bootstrap.settings;
    }
  }

  // Crash recovery: resume the governor's counters if this is a reload
  // within the same browsing session, not a brand-new one. Read via
  // background (see this file's header) — a `null` reply (nothing saved, or
  // the service worker didn't answer) simply means "start fresh". That is
  // safe here because nothing acts before the engine lease is held, and
  // gaining it loads the saved state again, this time failing closed.
  //
  // Called at load and on every live tick: an account whose plan gains
  // assist after the page loaded gets its engine without a reload.
  async function ensureGovernor(): Promise<void> {
    if (governor || !(features.includes('assist.ranker') || AUTOMATION_ENABLED)) return;
    const savedState = await send<GovernorState | null>('engine.stateGet');
    if (governor) return; // another call got here first
    const g = savedState ? Governor.hydrate(settingsCache.governor, savedState) : new Governor(settingsCache.governor);
    g.setKillSwitch(killSwitchActive, killSwitchActive ? 'server kill switch active at bootstrap' : undefined);
    applySettingsToEngine({ governor: g, automation: null }, settingsCache);
    // Surface any denial reasons the governor accumulates as risk-budget
    // telemetry — wrapped so every `allow()` call anywhere in this file's
    // engine wiring reports through one path — and save the state after
    // every decision, so a tab taking the lease over next sees it.
    const originalAllow = g.allow.bind(g);
    g.allow = (action, now) => {
      const decision = originalAllow(action, now);
      recordRiskEvents(decision.events);
      void persistState();
      return decision;
    };
    governor = g;

    lease = new EngineLease({
      ownerId: crypto.randomUUID(),
      acquire: async (ownerId) => {
        const answer = await bg.request<{ held: boolean; expiresAt: number }>('engine.lockAcquire', { ownerId });
        return answer.ok ? answer.data : null;
      },
      release: (ownerId) => void send('engine.lockRelease', { ownerId }),
      // Load what the last holder saved before acting. No answer from
      // background: give the lease back and try again at the next renewal.
      onGain: async () => {
        const saved = await bg.request<GovernorState | null>('engine.stateGet');
        if (!saved.ok) return false;
        if (saved.data) governor?.loadState(saved.data);
        return true;
      },
      onLose: () => {
        assist?.cancelPending();
        if (sniper?.isRunning()) sniper.stop('other_tab');
      },
    });
    await renewLease();
    setInterval(() => void renewLease(), LEASE_RENEW_MS);
  }

  /** Renews the lease and, while this tab holds it, reports its engine
   * state for the heartbeat (background/engine-lease.ts). */
  async function renewLease(): Promise<void> {
    if (!lease) return;
    await lease.refresh();
    if (lease.isHeld()) {
      const engineState = engineStateOf({
        killSwitch: killSwitchActive || !!governor?.isKillSwitchActive(),
        probeOk,
        automationRunning: !!sniper?.isRunning() || (!!autobuyer && !autobuyer.isStopped()),
        assistPaused: !!assist?.isPaused,
      });
      void send('engine.state', { engineState });
    }
  }

  let rankedCandidates: ScoredOpportunity[] = [];

  function recordAttempt(input: AttemptInput): void {
    const attempt: SnipingAttempt = {
      // Identifies this attempt through every retry of its flush, so the
      // API stores it once (lib/telemetry.ts).
      attemptId: crypto.randomUUID(),
      resourceId: input.resourceId,
      tradeId: input.tradeId,
      targetPrice: input.targetPrice,
      listedPrice: input.listedPrice,
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      searchMs: attemptTiming(input.searchMs),
      reactionMs: attemptTiming(input.reactionMs),
      // Cut to what the schema takes: a longer EA error had background
      // reject the whole item.
      errorCode: input.errorCode == null ? null : attemptErrorCode(input.errorCode),
      occurredAt: nowIso(),
      deviceId: deviceIdCache ?? '00000000-0000-0000-0000-000000000000',
    };
    void send('telemetry.enqueue', { kind: 'sniping', items: [attempt] satisfies SnipingAttempt[] });
  }

  function recordTrade(input: TradeInput): void {
    // Card fields from the listing that was bought, never the last card
    // searched for (lib/trade-report.ts); and, when the listing carried the
    // item's id, the lifecycle entry that later reports its sale against
    // this same tradeId.
    const { trade, lifecycle } = buildBoughtTrade(input, tracked.get(input.tradeId), nowIso());
    void send('telemetry.enqueue', { kind: 'trades', items: [trade] satisfies Trade[] });
    // Sent even with no item id: background counts those (diagnostics).
    void send('lifecycle.buy', lifecycle);
    if (!lifecycle.itemId) logger.warn(`bought trade ${input.tradeId} carried no item id: its sale cannot be followed`, 'lifecycle');
  }

  function recordRiskEvents(events: { kind: RiskBudgetEvent['kind']; value: number; threshold: number }[]): void {
    if (events.length === 0) return;
    const shaped: RiskBudgetEvent[] = events.map((e) => ({
      deviceId: deviceIdCache ?? '00000000-0000-0000-0000-000000000000',
      sessionId,
      kind: e.kind,
      value: e.value,
      threshold: e.threshold,
      occurredAt: nowIso(),
    }));
    void send('telemetry.enqueue', { kind: 'riskEvents', items: shaped });
  }

  let deviceIdCache: string | null = null;
  const sessionId = crypto.randomUUID();

  // Saved filters: cycled by assist (the active ones), searched by the
  // Sniping Bot, edited on the Sniping Bot page. One array so all three see
  // the same list; a change saved elsewhere arrives by `storage.onChanged`
  // (live settings, below).
  let filters = (await send<SavedFilter[]>('filters.list')) ?? [];
  let autobuyer: Autobuyer | null = null;

  await ensureGovernor();

  // The assist chords (lib/hotkeys.ts): Alt+Up/Down select a listing of the
  // current search, Alt+B shows the confirm overlay, a second Alt+B or a
  // click buys it. Trusted key presses only, and EA's own keys are never
  // prevented (content/assist-keys.ts).
  let overlay: ConfirmOverlay | null = null;
  const overlayUi = (): ConfirmOverlay => (overlay ??= createConfirmOverlay(document));
  installAssistHotkeys(document, () => assist);

  // Called at load and on every live tick (a plan that gains assist).
  function ensureAssist(): void {
    if (assist || !governor || !features.includes('assist.ranker')) return;
    assist = new AssistEngine({
      governor,
      adapter,
      getFilters: () => activeFilterHandles(filters),
      getRanked: () => rankedCandidates,
      // Only the lease holder acts, only while the plan includes assist, and
      // never on an EA app that failed its probe.
      canAct: () => !!lease?.isHeld() && features.includes('assist.ranker') && probeOk,
      hotkeys: DEFAULT_ASSIST_HOTKEYS,
      confirm: {
        show: (candidate) =>
          overlayUi().show(confirmDetailsFor(candidate, DEFAULT_ASSIST_HOTKEYS), {
            onConfirm: () => assist?.confirmPending(),
            onCancel: () => assist?.cancelPending(),
          }),
        hide: () => overlay?.hide(),
      },
      onSelectionChange: (tradeId) => {
        const at = rankedCandidates.findIndex((c) => c.tradeId === tradeId);
        const selected = rankedCandidates[at];
        if (selected) overlayUi().showSelection(selectionDetailsFor(selected, at, rankedCandidates.length, DEFAULT_ASSIST_HOTKEYS));
      },
      onFilterSelected: (handle) => {
        const filter = filters.find((f) => f.id === handle.id);
        if (!filter || !governor) return;
        // Engine-issued, so gated: a denied search is skipped (the denial is
        // already reported as a risk event by the `allow` wrapper above).
        void governedSearch(governor, adapter, filter.filter)
          .then((result) => {
            if (!result.searched) logger.warn(`filter search skipped by the governor: ${result.decision.reason ?? 'denied'}`, 'governor');
          })
          .catch((err) => logger.error(`filter search failed: ${String(err)}`, 'adapter.search'));
        // Reported whether or not the governor let the search through: the
        // event records the user choosing this filter, not a search (a
        // search that ran is reported on its own, as a `search` event).
        const event: ActivityEvent = {
          type: 'filter_change',
          occurredAt: nowIso(),
          metadata: { filterId: filter.id, action: 'activated' },
        };
        void send('telemetry.enqueue', { kind: 'activity', items: [event] });
      },
      onAttempt: recordAttempt,
      onTrade: recordTrade,
    });
  }
  ensureAssist();

  if (AUTOMATION_ENABLED && governor && features.includes('automation.autobuyer')) {
    const { loadAutobuyer } = await import('virtual:autobuyer-loader');
    const mod = await loadAutobuyer();
    if (mod) {
      autobuyer = new mod.Autobuyer({
        governor,
        adapter,
        onAttempt: recordAttempt,
        onTrade: recordTrade,
        sessionCoinBudget: settingsCache.budgets.sessionCoinBudget,
      });
    }
  }

  // ---- live settings: no page reload needed --------------------------------
  //
  // Background rewrites the settings cache from every bootstrap, heartbeat
  // and settings save; the Sniping Bot page saves the filters. Both reach
  // this tab through `storage.onChanged` (content/live-settings.ts), and the
  // governor's limits apply at once, clamped as at construction.
  watchLiveSettings(browser.storage.onChanged, {
    onSettings: (next) => {
      settingsCache = next;
      applySettingsToEngine({ governor, automation: autobuyer }, next);
    },
    onFilters: (next) => {
      filters = next;
    },
  });

  // Features and the kill switch from background's cached entitlement
  // (no network while it is fresh; the heartbeat refreshes it).
  async function liveTick(): Promise<void> {
    const boot = await send<BootstrapResponse>('license.bootstrap');
    if (!boot) return;
    features = boot.features;
    deviceIdCache = deviceIdCache ?? boot.deviceId;
    if (boot.killSwitchActive && !killSwitchActive) applyKillSwitch(true, 'server kill switch active');
    await ensureGovernor();
    ensureAssist();
  }
  setInterval(() => void liveTick(), LIVE_TICK_MS);

  // ---- M3: the Sniping Bot page -------------------------------------------
  //
  // Automation builds only (the listable build never loads `engine/sniper.ts`
  // — see `engine/autobuyer-loader.*.ts`). The bot runs its own governor from
  // the page's Safety limits; the server kill switch still stops it.
  if (AUTOMATION_ENABLED) {
    let botSettings: BotSettings | null = await send<BotSettings>('bot.settingsGet');
    let unavailableReason: string | null = null;
    // The search filled in on the bot page: the only one the bot runs. Never
    // written to the saved filters (assist and the dashboard use those).
    let liveSearch: LiveSearch | null = null;

    // Called at load and whenever the page opens: a user who signs in from
    // the account view after the page loaded gets the bot without a reload.
    // While the bot runs, this page holds a Web Lock: Chrome does not freeze
    // a page that holds one, so a background tab keeps searching. Shared,
    // so another EA tab is never kept waiting on it.
    let tabLock: { done: boolean; release?: () => void } | null = null;
    const holdTabWhileRunning = (): void => {
      const running = sniper?.isRunning() ?? false;
      if (running && !tabLock && typeof navigator.locks?.request === 'function') {
        const held: { done: boolean; release?: () => void } = { done: false };
        tabLock = held;
        void navigator.locks
          .request('nova-ai-running', { mode: 'shared' }, () =>
            new Promise<void>((resolve) => (held.done ? resolve() : (held.release = resolve))),
          )
          .catch(() => undefined);
      } else if (!running && tabLock) {
        tabLock.done = true;
        tabLock.release?.();
        tabLock = null;
      }
    };

    // Keeps the page's Sold / Unsold / Transfer list counts following the
    // bot: the web app reloads the transfer list soon after each card the
    // bot lists, and every few minutes while it runs or the page is open
    // (lib/pile-refresh.ts). The list arrives through `onTradePile` above.
    const pileRefresher = createPileRefresher({ refresh: () => adapter.refreshPile() });

    const prepareSniper = async (fresh: boolean): Promise<void> => {
      if (sniper) {
        // A plan lost mid-session (the check below) empties `features`, and
        // the bot then refuses to start. Opening the page re-checks, so a
        // user who signs back in or renews gets the bot without a reload.
        if (fresh && !features.includes('automation.autobuyer')) {
          const boot = await send<BootstrapResponse>('license.bootstrap');
          if (boot) {
            features = boot.features;
            killSwitchActive = killSwitchActive || boot.killSwitchActive;
          }
        }
        return;
      }
      let signedIn = !!authStatus?.authenticated;
      let allowed = features.includes('automation.autobuyer');
      if (fresh) {
        signedIn = !!(await send<{ authenticated: boolean }>('auth.status'))?.authenticated;
        const boot = signedIn ? await send<BootstrapResponse>('license.bootstrap') : null;
        allowed = !!boot?.features.includes('automation.autobuyer');
        if (boot) {
          features = boot.features;
          killSwitchActive = killSwitchActive || boot.killSwitchActive;
          deviceIdCache = deviceIdCache ?? boot.deviceId;
        }
      }
      botSettings = botSettings ?? (await send<BotSettings>('bot.settingsGet'));
      // No act-channel nonce: the adapter cannot authenticate a single
      // search or buy (handoff.js never ran on this page load).
      if (!actNonce) unavailableReason = NO_ACT_CHANNEL_REASON;
      else if (!signedIn) unavailableReason = 'Sign in to Nova Trade to use Nova AI.';
      else if (!allowed) unavailableReason = 'Your plan does not include Nova AI.';
      else if (!botSettings) unavailableReason = 'The extension could not load the bot settings. Reload the page.';
      else unavailableReason = null;
      if (unavailableReason || !botSettings) return;

      const { loadSniper } = await import('virtual:autobuyer-loader');
      const mod = await loadSniper();
      if (!mod) {
        unavailableReason = 'Nova AI is not available in this build.';
        return;
      }
      // Timed off the main thread, so the bot keeps its pace while the tab
      // is minimised or in the background (lib/background-timer.ts).
      const timer = createBackgroundTimer();
      // What a card sells for: FUTBIN's price, else what Nova saw it listed
      // at in the last half hour (model/market-price.ts), else unknown. Both
      // the profit estimate and auto-sell use it, so the profit a buy shows
      // is the one its listing aims for.
      const marketPrice = async (resourceId: number, platform: BotSettings['autoSell']['platform']) => {
        const futbin = await send<{ price: number | null }>('price.futbin', { resourceId, platform });
        if (futbin?.price) return { price: futbin.price, source: 'futbin' as const };
        const r = await send<{ market?: number | null }>('summary', { resourceId, minProfit: settingsCache.targets.minProfitPerSnipe });
        return r?.market ? { price: r.market, source: 'nova' as const } : null;
      };
      sniper = new mod.Sniper(
        {
          adapter: {
            search: adapter.search,
            buy: adapter.buy,
            list: async (tradeId, startPrice, buyNowPrice) => {
              const listed = await adapter.list(tradeId, startPrice, buyNowPrice);
              if (listed.ok) pileRefresher.listed();
              return listed;
            },
            onAuctions: adapter.onAuctions,
            onBuyable: adapter.onBuyable,
            onProbe: adapter.onProbe,
            onShape: adapter.onShape,
            onEaError: adapter.onEaError,
          },
          sleep: timer.sleep,
          timingMode: timer.mode,
          getFilters: () => (liveSearch ? [liveSearch] : []),
          // Not the week's median of every listing (model/prices.ts): that
          // ran far above what cards sell for.
          estimateSellPrice: async (resourceId) =>
            (await marketPrice(resourceId, (botSettings ?? DEFAULT_BOT_SETTINGS).autoSell.platform))?.price ?? null,
          marketPrice,
          // The hours-per-day limit survives a page reload.
          loadUsage: () => send<BotDailyUsage | null>('bot.usageGet'),
          saveUsage: (usage) => void send('bot.usageSet', usage),
          // The hourly budgets survive Stop/Start and a page reload too.
          // Rejects when background did not answer, which the bot treats as
          // "cannot start" — never as "nothing saved" (finding A).
          loadBudget: () => bg.requireAnswer<BotBudgetState | null>('bot.budgetGet'),
          saveBudget: (budget) => void send('bot.budgetSet', budget),
          entitled: () => features.includes('automation.autobuyer'),
          // One EA tab runs the bot: the one holding the engine lease.
          exclusive: () => !!lease?.isHeld(),
          killSwitch: () => ({ active: killSwitchActive || !!governor?.isKillSwitchActive() }),
          onChange: () => {
            holdTabWhileRunning();
            // A start reloads the list at once (when the last is old).
            pileRefresher.tick(sniper?.isRunning() ?? false);
            botPage.refresh();
          },
          onAttempt: recordAttempt,
          onTrade: recordTrade,
          onRiskEvent: (event) => recordRiskEvents([event]),
        },
        botSettings,
      );
    };
    await prepareSniper(false);

    // A plan that loses the bot mid-session (the heartbeat refreshes
    // background's cached entitlement) stops it with a reason, not at the
    // next page load. The kill switch has its own push and pull above.
    let entitlementMisses = 0;
    setInterval(() => {
      const autobuyerRunning = !!autobuyer && !autobuyer.isStopped();
      if (!sniper?.isRunning() && !autobuyerRunning) return;
      void send<BootstrapResponse>('license.bootstrap').then((boot) => {
        if (boot) {
          entitlementMisses = 0;
          features = boot.features;
          if (boot.killSwitchActive) applyKillSwitch(true, 'server kill switch active');
        } else if (++entitlementMisses >= 2) {
          // No entitlement at all (signed out, or background has none to
          // give): fail closed.
          features = [];
        }
        if (features.includes('automation.autobuyer')) return;
        sniper?.stop('not_entitled');
        if (autobuyer && !autobuyer.isStopped()) {
          autobuyer.stop('not_entitled', 'your plan no longer includes automation');
          reportAutobuyerStop('not_entitled', 'your plan no longer includes automation');
        }
      });
    }, ENTITLEMENT_CHECK_MS);

    const botPage = createBotPage({
      getSniper: () => sniper,
      getUnavailableReason: () => (sniper ? null : unavailableReason),
      prepare: () => prepareSniper(true),
      getSettings: () => botSettings ?? DEFAULT_BOT_SETTINGS,
      saveSettings: async (next) => {
        // A change of risk level is reported, so admins can see who runs
        // the bot on risky settings.
        const modeEvent = riskLevelChangeEvent(botSettings, next, nowIso(), deviceIdCache);
        botSettings = next;
        await send('bot.settingsSet', next);
        if (modeEvent) void send('telemetry.enqueue', { kind: 'activity', items: [modeEvent] });
      },
      setLiveSearch: (search) => {
        liveSearch = search;
      },
      resolveNames: async (resourceIds) => (await send<Record<string, string | null>>('cards.names', { resourceIds })) ?? {},
      getCatalog: () => send<Catalog | null>('catalog.get'),
      // The signed-in account's list, through background, so every browser
      // shows the same one; a copy in extension storage (Tampermonkey's in
      // the userscript build), which EA's page cannot read, for when the
      // account cannot be reached (content/recent-searches.ts).
      recentSearches: createRecentSearchesSync({
        storage: {
          get: async (key) => (await browser.storage.local.get(key))[key],
          set: (key, value) => browser.storage.local.set({ [key]: value }),
        },
        send,
      }),
      // Read from the trade-pile responses EA's page fetched (above), never
      // from a request of the extension's own.
      getTransferList: () => transferList.summary(),
      getCredits: () => eaCredits,
    });
    const nav = installNavItem({
      onToggle: () => botPage.toggle(),
      onEaNavigate: () => botPage.close(),
      onBounds: (bounds) => botPage.setBounds(bounds),
    });
    botPage.onOpenChange((open) => {
      nav.setActive(open);
      if (open) pileRefresher.tick(true);
    });
    // The every-few-minutes reloads: checked twice per minimum gap, cheap
    // when nothing is due.
    setInterval(() => pileRefresher.tick((sniper?.isRunning() ?? false) || botPage.isOpen()), PILE_MIN_GAP_MS / 2);
  }

  async function refreshSummaries(listings: readonly TrimmedAuction[]): Promise<void> {
    // Capped at 20 distinct cards per search — fetched concurrently rather
    // than one `send()` round trip at a time, since each request is
    // independent of the others.
    const capped = [...new Set(listings.map((a) => a.resourceId))].slice(0, 20);
    await Promise.all(
      capped.map(async (resourceId) => {
        const result = await send<{ resourceId: number; summary: PriceSummary }>('summary', {
          resourceId,
          minProfit: settingsCache.targets.minProfitPerSnipe,
        });
        if (result) lastSummaryByResource.set(resourceId, result.summary);
      }),
    );
  }

  /** Ranks the current search's listings (content/candidates.ts) — never a
   * listing from an earlier search, however recently it was tracked. On
   * every search and every engine tick; a newer search arriving while this
   * one awaits its summaries wins. */
  let rankGeneration = 0;
  async function rerank(): Promise<void> {
    const generation = ++rankGeneration;
    const listings = currentSearch;
    await refreshSummaries(listings);
    if (generation !== rankGeneration) return;
    const candidates = currentCandidates(listings, lastSummaryByResource, Date.now());
    rankedCandidates = rankCandidates(candidates, { minEv: settingsCache.targets.minProfitPerSnipe });
    // A confirm overlay for a listing no longer on offer is stale.
    const pending = assist?.pendingTradeId;
    if (pending && !rankedCandidates.some((c) => c.tradeId === pending)) assist?.cancelPending();
  }
  engineReady = true;

  async function engineTickImpl(): Promise<void> {
    if (!governor || !probeOk) return;
    const pulled = await send<{ active: boolean; reason?: string }>('license.killSwitchGet');
    if (pulled && pulled.active !== killSwitchActive) applyKillSwitch(pulled.active, pulled.reason);
    if (killSwitchActive) return; // nothing to rank or attempt while halted
    // While the Sniping Bot runs nothing buys from a ranking (see
    // `onCurrentSearch` above): no ranking, no price lookups.
    if (sniper?.isRunning()) return;
    await rerank();

    // The Sniping Bot buys on its own; never let two engines buy at once —
    // nor two tabs: only the engine lease holder runs the autobuyer.
    if (lease?.isHeld() && autobuyer && !autobuyer.isStopped() && !sniper?.isRunning()) {
      await autobuyer.runCycle(rankedCandidates.slice(0, 5));
      const stop = autobuyer.getStopReason();
      if (stop) reportAutobuyerStop(stop.reason, stop.detail);
    }
  }

  // Re-entrancy guard (docs/12-testing.md "Defects found"): `refreshSummaries`
  // above can take up to 20 sequential-looking `send()` round trips (now
  // concurrent, but still not instant) and `autobuyer.runCycle` awaits a
  // full buy cycle — both comfortably longer than a single tick interval is
  // guaranteed to be. Without a guard, `setInterval` could fire a second
  // `engineTick` while the first was still awaiting either of those, running
  // two overlapping autobuyer cycles against the same tracked auctions. This
  // drops any tick that fires while one is already in flight rather than
  // queuing or overlapping it.
  const engineTick = singleFlight(engineTickImpl);

  function reportAutobuyerStop(reason: StopReason, detail: string): void {
    logger.error(`autobuyer stopped: ${reason} — ${detail}`, 'autobuyer');
  }

  // Returns at once while there is no governor (no engine on this account).
  setInterval(() => void engineTick(), AUTOBUYER_TICK_MS);

  // The session P&L (lifecycle.sessionPnl) and risk-snapshot UI ticks that
  // used to push into the in-page panel are gone with the panel itself
  // (claude/bot-page-redesign) — the governor-snapshot relay's only
  // consumer was the popup gauge, also removed. sessionMeters()/
  // dailyGoalProgress() (lib/session-meters.ts) are ready as data functions
  // for the Nova AI bot page to call directly if wanted.
  // ---- crash recovery: persist governor state via background -------------

  // Only the engine lease holder saves: another tab's governor is a stale
  // copy, and saving it would overwrite what the holder spent.
  async function persistState(): Promise<void> {
    if (!governor || !lease?.isHeld()) return;
    await send('engine.stateSet', governor.serialize());
  }
  setInterval(() => void persistState(), STATE_PERSIST_MS);
  window.addEventListener('pagehide', (e) => {
    // Saved first, then the lease given back, so the next tab to gain it
    // loads this tab's last numbers.
    void persistState();
    lease?.release();
    // A page kept in the back/forward cache may come back: keep counting.
    if (!e.persisted) stopCountingSearches();
  });

  // ---- watchdog: notice a MAIN-world adapter that has gone quiet ----------
  //
  // The adapter's heartbeat keeps it fed while nothing else happens; a
  // background tab's throttled timers, a few quiet checks or a recent
  // warning do not set it off (content/watchdog.ts).
  const watchdog = createWatchdog({
    staleMs: WATCHDOG_STALE_MS,
    hiddenStaleMs: WATCHDOG_HIDDEN_STALE_MS,
    checkMs: WATCHDOG_MS,
    isHidden: () => document.visibilityState === 'hidden',
    warn: (quietMs) =>
      logger.warn(`adapter has not reported a probe result or heartbeat for ${Math.round(quietMs / 1000)} s — possible MAIN-world stall`, 'watchdog'),
    recovered: () => logger.info('adapter is reporting again', 'watchdog'),
  });
  adapter.onProbe(() => watchdog.seen());
  adapter.onHeartbeat(() => watchdog.seen());
  setInterval(() => watchdog.check(), WATCHDOG_MS);

  // Keeps `deviceId` fresh for attempt/trade/risk-event reporting above.
  // (The engine state for the heartbeat goes with every lease renewal:
  // `renewLease()`.)
  const bootstrapForDevice = authStatus?.authenticated ? await send<BootstrapResponse>('license.bootstrap') : null;
  deviceIdCache = bootstrapForDevice?.deviceId ?? deviceIdCache;
}

/** What an EA error's request was for, in a log line. */
const EA_ENDPOINT_WORDS: Record<AdapterEaError['endpoint'], string> = {
  market: 'market search',
  pile: 'transfer list request',
  bid: 'buy',
  other: 'request',
};

/** Shown on the Nova AI page when no act-channel nonce was handed off. */
const NO_ACT_CHANNEL_REASON =
  "Nova Trade could not open a secure connection to EA's web app on this page load, so Nova AI is locked. Reload the page to use it.";

function start(): void {
  void main().catch((err) => {
    // M1 recording is wired up synchronously at the top of main() and keeps
    // working whatever happens below it; a failed M2/M3 bootstrap is reported,
    // never allowed to become a silent unhandled rejection.
    logger.error(`content bootstrap failed (recording continues): ${String(err)}`, 'content');
  });
}

// The extension injects this file at document_idle, so the first branch is
// never taken there. The userscript build evaluates it at document-start (so
// the MAIN-world adapter is in place before EA's first market call) and the
// bot page needs a <body> to attach to.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
