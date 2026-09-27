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
 */
import { DEFAULT_BOT_SETTINGS, extContentKillSwitchMessageSchema } from '@sl/shared';
import browser from 'webextension-polyfill';

import { AssistEngine } from '../engine/assist.js';
import { Governor, type GovernorState } from '../engine/governor.js';
import { rankCandidates, type OpportunityCandidate, type ScoredOpportunity } from '../engine/ranker.js';
import { countObservedSearches, governedSearch } from '../engine/search.js';
import { readHandedOffNonce } from '../lib/act-auth.js';
import { riskLevelChangeEvent } from '../lib/bot-safety.js';
import { logger } from '../lib/logger.js';
import { singleFlight } from '../lib/single-flight.js';
import { buildBoughtTrade } from '../lib/trade-report.js';
import { createBotPage, type LiveSearch } from '../ui/bot-page.js';
import { installNavItem } from '../ui/ea-nav.js';
import { onTrusted } from '../ui/trusted-events.js';

import { createAdapterClient, pageWindow } from './adapter-client.js';
import { createDiagnosticsResponder } from './diagnostics.js';
import { createSearchObserver } from './search-observer.js';

import type { Autobuyer, StopReason } from '../engine/autobuyer.js';
import type { Sniper } from '../engine/sniper.js';
import type { AttemptInput, TradeInput } from '../engine/types.js';
import type { Catalog } from '../model/catalog.js';
import type { PriceSummary } from '../model/prices.js';
import type {
  ActivityEvent,
  BotBudgetState,
  BotDailyUsage,
  BotSettings,
  BackgroundResponse,
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
/** How often a running Sniping Bot re-reads the entitlement (background's
 * cached `license.bootstrap`, refreshed by its heartbeat), so a plan that
 * loses the bot stops it mid-session. */
const ENTITLEMENT_CHECK_MS = 30000;

// ---- background messaging ---------------------------------------------------

async function send<T = unknown>(type: string, payload?: unknown): Promise<T | null> {
  try {
    const res = (await browser.runtime.sendMessage({ type, payload })) as BackgroundResponse | undefined;
    if (!res) return null; // dead/reloaded service worker
    if (!res.ok) {
      logger.warn(`background rejected '${type}': ${res.error}`, 'content');
      return null;
    }
    return res.data as T;
  } catch (err) {
    logger.warn(`sendMessage('${type}') failed: ${String(err)}`, 'content');
    return null;
  }
}

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
  let lastRating: number | null = null;
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
      onDominant: (resourceId, rating) => {
        lastResourceId = resourceId;
        lastRating = rating;
      },
      reportSearch: reportSearchActivity,
      record: (auctions) => {
        recordQueue = recordQueue.concat(auctions);
        scheduleFlush();
      },
    }),
  );

  // Every observed search response counts toward the governor's
  // buy/search ratio and actionsPerHour — the human searching in EA's own UI
  // is what keeps assist-mode buys allowed (engine/search.ts). A no-op until
  // the bootstrap below has created a governor.
  countObservedSearches(adapter, () => governor);

  // The trader's own trade pile (defect C13): background's trade lifecycle
  // links each item to the buy it came from and reports its sale once
  // (lib/trade-lifecycle.ts). Not a search: nothing is counted here.
  adapter.onTradePile((items: TradePileItem[], full: boolean) => {
    void send('lifecycle.pile', { items, full });
  });

  let probeOk = true;
  adapter.onProbe((status) => {
    probeOk = status.ok;
    if (!status.ok) {
      logger.error(`bundle probe failed: ${status.reason}`, 'adapter.probe');
      void send('telemetry.enqueue', {
        kind: 'activity',
        items: [{ type: 'error', occurredAt: nowIso(), metadata: { code: 'ADAPTER_PROBE_FAILED', message: status.reason ?? 'unknown', context: 'adapter.probe' } }] satisfies ActivityEvent[],
      });
    }
  });

  adapter.onShape((reason) => {
    logger.warn(`market payload shape changed: ${reason}`, 'adapter.shape');
  });

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
  // the service worker didn't answer) simply means "start fresh".
  const savedState = await send<GovernorState | null>('engine.stateGet');
  governor =
    features.includes('assist.ranker') || AUTOMATION_ENABLED
      ? savedState
        ? Governor.hydrate(settingsCache.governor, savedState)
        : new Governor(settingsCache.governor)
      : null;
  governor?.setKillSwitch(killSwitchActive, killSwitchActive ? 'server kill switch active at bootstrap' : undefined);

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
      errorCode: input.errorCode,
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

  // Saved filters: rotated by assist.
  const filters = (await send<SavedFilter[]>('filters.list')) ?? [];

  if (governor && features.includes('assist.ranker')) {
    assist = new AssistEngine({
      governor,
      adapter,
      getFilters: () => filters.map((f) => ({ id: f.id })),
      getRanked: () => rankedCandidates,
      onFilterSelected: (handle) => {
        const filter = filters.find((f) => f.id === handle.id);
        if (!filter || !governor) return;
        // Engine-issued, so gated: a denied search is skipped (the denial is
        // already reported as a risk event by the `allow` wrapper below).
        void governedSearch(governor, adapter, filter.filter)
          .then((result) => {
            if (!result.searched) logger.warn(`filter search skipped by the governor: ${result.decision.reason ?? 'denied'}`, 'governor');
          })
          .catch((err) => logger.error(`filter search failed: ${String(err)}`, 'adapter.search'));
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

    // Trusted key presses only: the confirm key buys, and a page script can
    // dispatch a synthetic keydown on `document` (ui/trusted-events.ts).
    onTrusted(document, 'keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(input|textarea|select)$/i.test(target.tagName);
      if (typing || !assist) return;
      if (assist.handleKeydown(e.key)) e.preventDefault();
    });
  }

  let autobuyer: Autobuyer | null = null;
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
      // search or buy. In the userscript that means page scripts had already
      // run when it installed (userscript/setup.ts refuses the handoff then).
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
      sniper = new mod.Sniper(
        {
          adapter,
          getFilters: () => (liveSearch ? [liveSearch] : []),
          estimateSellPrice: async (resourceId) => {
            const r = await send<{ summary: PriceSummary }>('summary', { resourceId, minProfit: settingsCache.targets.minProfitPerSnipe });
            return r?.summary.median ?? null;
          },
          // The hours-per-day limit survives a page reload.
          loadUsage: () => send<BotDailyUsage | null>('bot.usageGet'),
          saveUsage: (usage) => void send('bot.usageSet', usage),
          // The hourly budgets survive Stop/Start and a page reload too.
          loadBudget: () => send<BotBudgetState | null>('bot.budgetGet'),
          saveBudget: (budget) => void send('bot.budgetSet', budget),
          entitled: () => features.includes('automation.autobuyer'),
          killSwitch: () => ({ active: killSwitchActive || !!governor?.isKillSwitchActive() }),
          onChange: () => botPage.refresh(),
          onAttempt: recordAttempt,
          onTrade: recordTrade,
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
    });
    const nav = installNavItem({
      onToggle: () => botPage.toggle(),
      onEaNavigate: () => botPage.close(),
      onBounds: (bounds) => botPage.setBounds(bounds),
    });
    botPage.onOpenChange((open) => nav.setActive(open));
  }

  function buildCandidatesFromTracked(): OpportunityCandidate[] {
    // Cap the number of distinct cards summarised per tick — this is a
    // content-script loop (rule 5 allows it here), but it should still be a
    // handful of background round trips, not one per tracked auction.
    const byResource = new Map<number, TrimmedAuction[]>();
    for (const a of tracked.values()) {
      if (a.expiresAt != null && a.expiresAt < Date.now()) continue;
      const list = byResource.get(a.resourceId) ?? [];
      list.push(a);
      byResource.set(a.resourceId, list);
    }
    return Array.from(byResource.entries())
      .slice(0, 20)
      .flatMap(([, auctions]) =>
        // A listing the adapter said it cannot buy never becomes a candidate
        // (engine/ranker.ts drops `buyable: false` too, belt and braces).
        auctions
          .filter((a) => a.buyable !== false)
          .map((a) => ({ resourceId: a.resourceId, tradeId: a.tradeId, price: a.buyNow, summary: lastSummaryByResource.get(a.resourceId) })),
      )
      .filter((c): c is OpportunityCandidate => c.summary != null);
  }

  const lastSummaryByResource = new Map<number, PriceSummary>();

  async function refreshSummaries(): Promise<void> {
    const resourceIds = new Set<number>();
    for (const a of tracked.values()) resourceIds.add(a.resourceId);
    // Capped at 20 distinct resources per tick (same cap as before) — fetched
    // concurrently rather than one `send()` round trip at a time, since each
    // request is independent of the others.
    const capped = Array.from(resourceIds).slice(0, 20);
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

  async function engineTickImpl(): Promise<void> {
    if (!governor || !probeOk) return;
    const pulled = await send<{ active: boolean; reason?: string }>('license.killSwitchGet');
    if (pulled && pulled.active !== killSwitchActive) applyKillSwitch(pulled.active, pulled.reason);
    if (killSwitchActive) return; // nothing to rank or attempt while halted
    await refreshSummaries();
    const candidates = buildCandidatesFromTracked();
    rankedCandidates = rankCandidates(candidates, { minEv: settingsCache.targets.minProfitPerSnipe });

    // The Sniping Bot buys on its own; never let two engines buy at once.
    if (autobuyer && !autobuyer.isStopped() && !sniper?.isRunning()) {
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

  if (governor) {
    setInterval(() => void engineTick(), AUTOBUYER_TICK_MS);
  }

  // The session P&L (lifecycle.sessionPnl) and risk-snapshot UI ticks that
  // used to push into the in-page panel are gone with the panel itself
  // (claude/bot-page-redesign) — the governor-snapshot relay's only
  // consumer was the popup gauge, also removed. The underlying data
  // (background/lifecycle.ts, lib/trade-lifecycle.ts) is untouched and can
  // be surfaced on the Nova AI bot page directly if wanted.
  // ---- crash recovery: persist governor state via background -------------

  async function persistState(): Promise<void> {
    if (!governor) return;
    await send('engine.stateSet', governor.serialize());
  }
  setInterval(() => void persistState(), STATE_PERSIST_MS);
  window.addEventListener('pagehide', () => void persistState());

  // ---- watchdog: notice a MAIN-world adapter that has gone quiet ----------

  let lastProbeAt = Date.now();
  adapter.onProbe(() => {
    lastProbeAt = Date.now();
  });
  setInterval(() => {
    if (Date.now() - lastProbeAt > WATCHDOG_STALE_MS) {
      logger.warn('adapter has not reported a probe result recently — possible MAIN-world stall', 'watchdog');
    }
  }, WATCHDOG_MS);

  // periodic heartbeat with the live engine state, distinct from
  // background's own 10-minute license heartbeat alarm — this one just
  // keeps `deviceId` fresh for attempt/trade/risk-event reporting above.
  const bootstrapForDevice = authStatus?.authenticated ? await send<BootstrapResponse>('license.bootstrap') : null;
  deviceIdCache = bootstrapForDevice?.deviceId ?? null;

  // Surface any denial reasons the governor accumulates as risk-budget
  // telemetry — wrapped so every `allow()` call anywhere in this file's
  // engine wiring reports through one path.
  const originalAllow = governor?.allow.bind(governor);
  if (governor && originalAllow) {
    governor.allow = (action, now) => {
      const decision = originalAllow(action, now);
      recordRiskEvents(decision.events);
      return decision;
    };
  }
}

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
