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
import { logger } from '../lib/logger.js';
import { setBotPageOpener } from '../ui/bot-opener.js';
import { createBotPage } from '../ui/bot-page.js';
import { installNavItem } from '../ui/ea-nav.js';
import { createPanel, type Panel } from '../ui/panel.js';

import { createAdapterClient } from './adapter-client.js';

import type { Autobuyer, StopReason } from '../engine/autobuyer.js';
import type { Sniper } from '../engine/sniper.js';
import type { AttemptInput, TradeInput } from '../engine/types.js';
import type { PriceSummary } from '../model/prices.js';
import type {
  ActivityEvent,
  BotSettings,
  BackgroundResponse,
  BootstrapResponse,
  FeatureKey,
  RiskBudgetEvent,
  SavedFilter,
  SnipingAttempt,
  Trade,
  TrimmedAuction,
  UserSettings,
} from '@sl/shared';

const AUTOMATION_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

const RECORD_FLUSH_MS = 2000;
const RECORD_FLUSH_AT = 300;
const STATE_PERSIST_MS = 5000;
const RISK_UI_TICK_MS = 3000;
const AUTOBUYER_TICK_MS = 8000;
const WATCHDOG_MS = 15000;
const WATCHDOG_STALE_MS = 60000;

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
  const panel: Panel = createPanel();
  const adapter = createAdapterClient(window);

  panel.setHealth('live', 'Recording. Nothing beyond product telemetry (docs/06-extension.md) is sent.');
  send('counts').then((data) => data && panel.setTotals(data as { auctions: number; playersLast24h: number }));

  // ---- M1: passive observation (always on, no account required) -----------

  let recordQueue: TrimmedAuction[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let searches = 0;
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
  // Server kill switch, tracked here as well as inside the governor so the
  // panel reports it even on an account with no engine (M1-only), and so
  // an `engine.killSwitch` push arriving before the M2 bootstrap finishes
  // is not lost (it is re-applied to the governor once one exists).
  let killSwitchActive = false;

  function dominantResource(auctions: TrimmedAuction[]): number | null {
    const tally = new Map<number, number>();
    for (const a of auctions) tally.set(a.resourceId, (tally.get(a.resourceId) ?? 0) + 1);
    let best: number | null = null;
    let bestN = 0;
    for (const [id, n] of tally) if (n > bestN) { best = id; bestN = n; }
    return best != null && bestN / auctions.length >= 0.5 ? best : null;
  }

  async function flushRecordQueue(): Promise<void> {
    flushTimer = null;
    if (recordQueue.length === 0) return;
    const batch = recordQueue;
    recordQueue = [];

    const result = await send('record', { auctions: batch });
    if (!result) {
      panel.setHealth('warn', 'Recorded nothing — the extension background may have reloaded.');
      return;
    }

    const totals = await send<{ auctions: number; playersLast24h: number }>('counts');
    if (totals) panel.setTotals(totals);

    if (lastResourceId != null) {
      const summary = await send<{
        resourceId: number;
        summary: PriceSummary;
        maxSnipe: number | null;
        recentPrices?: number[];
      }>('summary', { resourceId: lastResourceId, minProfit: settingsCache.targets.minProfitPerSnipe });
      if (summary) {
        panel.setCard({ resourceId: summary.resourceId, rating: lastRating, summary: summary.summary, maxSnipe: summary.maxSnipe });
        panel.setSparkline(summary.recentPrices ?? []);
      }
    }
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

  adapter.onAuctions((raw) => {
    const auctions = raw as TrimmedAuction[];
    searches++;
    panel.setSearches(searches);
    panel.setHealth(engineHealthState(), engineHealthMessage());

    for (const a of auctions) {
      tracked.set(a.tradeId, a);
    }
    // Prune anything long expired so `tracked` doesn't grow without bound.
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, a] of tracked) if (a.expiresAt != null && a.expiresAt < cutoff) tracked.delete(id);

    if (auctions.length > 0) {
      const dominant = dominantResource(auctions);
      if (dominant != null) {
        lastResourceId = dominant;
        lastRating = auctions.find((a) => a.resourceId === dominant)?.rating ?? null;
      }
      // No real filter is known for a manually-run EA search (the adapter
      // only sees the response, not the request) — `resource:<id>` is a
      // coarse, documented stand-in filter hash (docs/06-extension.md).
      reportSearchActivity(dominant != null ? `resource:${dominant}` : 'mixed', auctions);
      recordQueue = recordQueue.concat(auctions);
      scheduleFlush();
    }
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
    panel.setHealth(engineHealthState(), engineHealthMessage());
  });

  adapter.onShape((reason) => {
    logger.warn(`market payload shape changed: ${reason}`, 'adapter.shape');
    panel.setHealth('warn', `Not recording — the market response changed shape (${reason}). adapter.ts needs updating.`);
  });

  function engineHealthState(): 'live' | 'warn' | 'risk' {
    if (!probeOk) return 'warn';
    if (killSwitchActive || governor?.isKillSwitchActive()) return 'risk';
    return 'live';
  }
  function engineHealthMessage(): string {
    if (!probeOk) return `Bundle probe failed — assist/automation are hard-stopped until adapter.ts is updated.`;
    if (killSwitchActive || governor?.isKillSwitchActive()) return 'Kill switch active — all actions blocked.';
    return assist ? 'Assist engine active.' : 'Recording. Nothing beyond product telemetry is sent.';
  }

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
    if (changed) {
      if (active) logger.warn(`kill switch active — ${reason ?? 'server kill switch active'}`, 'kill-switch');
      else logger.info('kill switch cleared by the server', 'kill-switch');
    }
    panel.setHealth(engineHealthState(), engineHealthMessage());
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
    const trade: Trade = {
      id: crypto.randomUUID(),
      tradeId: input.tradeId,
      resourceId: input.resourceId,
      assetId: null,
      rating: lastRating,
      buyPrice: input.buyPrice,
      sellPrice: null,
      eaTax: 0.05,
      netProfit: null,
      status: 'bought',
      boughtAt: nowIso(),
      soldAt: null,
    };
    void send('telemetry.enqueue', { kind: 'trades', items: [trade] satisfies Trade[] });
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

  // Saved filters: rotated by assist, searched by the Sniping Bot, edited
  // on the Sniping Bot page. One array so all three see the same list.
  let filters = (await send<SavedFilter[]>('filters.list')) ?? [];

  if (governor && features.includes('assist.ranker')) {
    assist = new AssistEngine({
      governor,
      adapter,
      getFilters: () => filters.map((f) => ({ id: f.id })),
      getRanked: () => rankedCandidates,
      onFilterSelected: (handle) => {
        const filter = filters.find((f) => f.id === handle.id);
        if (!filter) return;
        void adapter.search(filter.filter);
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

    document.addEventListener('keydown', (e) => {
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
  let sniper: Sniper | null = null;
  if (AUTOMATION_ENABLED) {
    let botSettings: BotSettings | null = await send<BotSettings>('bot.settingsGet');
    let unavailableReason: string | null = null;

    // Called at load and whenever the page opens: a user who signs in from
    // the SL drawer after the page loaded gets the bot without a reload.
    const prepareSniper = async (fresh: boolean): Promise<void> => {
      if (sniper) return;
      let signedIn = !!authStatus?.authenticated;
      let allowed = features.includes('automation.autobuyer');
      if (fresh) {
        signedIn = !!(await send<{ authenticated: boolean }>('auth.status'))?.authenticated;
        const boot = signedIn ? await send<BootstrapResponse>('license.bootstrap') : null;
        allowed = !!boot?.features.includes('automation.autobuyer');
        if (boot) {
          killSwitchActive = killSwitchActive || boot.killSwitchActive;
          deviceIdCache = deviceIdCache ?? boot.deviceId;
        }
      }
      botSettings = botSettings ?? (await send<BotSettings>('bot.settingsGet'));
      if (!signedIn) unavailableReason = 'Sign in (SL button) to use the Sniping Bot.';
      else if (!allowed) unavailableReason = 'Your plan does not include the Sniping Bot.';
      else if (!botSettings) unavailableReason = 'The extension could not load the bot settings. Reload the page.';
      else unavailableReason = null;
      if (unavailableReason || !botSettings) return;

      const { loadSniper } = await import('virtual:autobuyer-loader');
      const mod = await loadSniper();
      if (!mod) {
        unavailableReason = 'The Sniping Bot is not available in this build.';
        return;
      }
      sniper = new mod.Sniper(
        {
          adapter,
          getFilters: () => filters.filter((f) => f.isActive).map((f) => ({ id: f.id, name: f.name, filter: f.filter })),
          estimateSellPrice: async (resourceId) => {
            const r = await send<{ summary: PriceSummary }>('summary', { resourceId, minProfit: settingsCache.targets.minProfitPerSnipe });
            return r?.summary.median ?? null;
          },
          killSwitch: () => ({ active: killSwitchActive || !!governor?.isKillSwitchActive() }),
          onChange: () => botPage.refresh(),
          onAttempt: recordAttempt,
          onTrade: recordTrade,
        },
        botSettings,
      );
    };
    await prepareSniper(false);

    const botPage = createBotPage({
      getSniper: () => sniper,
      getUnavailableReason: () => (sniper ? null : unavailableReason),
      prepare: () => prepareSniper(true),
      getSettings: () => botSettings ?? DEFAULT_BOT_SETTINGS,
      saveSettings: async (next) => {
        botSettings = next;
        await send('bot.settingsSet', next);
      },
      getFilters: () => filters,
      saveFilters: async (next) => {
        filters = next;
        await send('filters.save', { filters: next });
      },
      resolveNames: async (resourceIds) => (await send<Record<string, string | null>>('cards.names', { resourceIds })) ?? {},
    });
    const nav = installNavItem({
      onToggle: () => botPage.toggle(),
      onEaNavigate: () => botPage.close(),
      onOffset: (left, top) => botPage.setOffsets(left, top),
    });
    botPage.onOpenChange((open) => nav.setActive(open));
    setBotPageOpener(() => botPage.open());
    panel.setBotLauncher(() => botPage.open());
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
      .flatMap(([, auctions]) => auctions.map((a) => ({ resourceId: a.resourceId, tradeId: a.tradeId, price: a.buyNow, summary: lastSummaryByResource.get(a.resourceId) })))
      .filter((c): c is OpportunityCandidate => c.summary != null);
  }

  const lastSummaryByResource = new Map<number, PriceSummary>();

  async function refreshSummaries(): Promise<void> {
    const resourceIds = new Set<number>();
    for (const a of tracked.values()) resourceIds.add(a.resourceId);
    let n = 0;
    for (const resourceId of resourceIds) {
      if (n++ >= 20) break;
      const result = await send<{ resourceId: number; summary: PriceSummary }>('summary', {
        resourceId,
        minProfit: settingsCache.targets.minProfitPerSnipe,
      });
      if (result) lastSummaryByResource.set(resourceId, result.summary);
    }
  }

  async function engineTick(): Promise<void> {
    if (!governor || !probeOk) return;
    const pulled = await send<{ active: boolean; reason?: string }>('license.killSwitchGet');
    if (pulled && pulled.active !== killSwitchActive) applyKillSwitch(pulled.active, pulled.reason);
    if (killSwitchActive) return; // nothing to rank or attempt while halted
    await refreshSummaries();
    const candidates = buildCandidatesFromTracked();
    rankedCandidates = rankCandidates(candidates, { minEv: settingsCache.targets.minProfitPerSnipe });
    panel.setRanked(rankedCandidates);

    // The Sniping Bot buys on its own; never let two engines buy at once.
    if (autobuyer && !autobuyer.isStopped() && !sniper?.isRunning()) {
      await autobuyer.runCycle(rankedCandidates.slice(0, 5));
      const stop = autobuyer.getStopReason();
      if (stop) reportAutobuyerStop(stop.reason, stop.detail);
    }
  }

  function reportAutobuyerStop(reason: StopReason, detail: string): void {
    logger.error(`autobuyer stopped: ${reason} — ${detail}`, 'autobuyer');
    panel.setHealth('warn', `Automation stopped (${reason}): ${detail}`);
  }

  if (governor) {
    setInterval(() => void engineTick(), AUTOBUYER_TICK_MS);
  }

  // ---- risk meter / session P&L UI tick ------------------------------------

  setInterval(() => {
    if (!governor) return;
    const snapshot = governor.snapshot();
    panel.setRiskSnapshot(snapshot);
    if (assist) panel.setSessionPnl(assist.sessionPnl);
    // Defect (docs/10-design-system.md §15 "Known gap"): the popup showed
    // no live risk gauge at all — only this in-page panel did. Pushing the
    // same snapshot the panel just rendered to background (cached in
    // `storage.session`, `background/governor.ts`) lets the popup show the
    // real segmented gauge too, without ever reconstructing/recomputing a
    // safety-critical number outside the governor's own math.
    void send('governor.snapshotPush', snapshot);
  }, RISK_UI_TICK_MS);

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
// panel needs a <body> to attach to.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
