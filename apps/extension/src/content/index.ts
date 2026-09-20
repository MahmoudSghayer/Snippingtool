/*
 * content/index.ts — the ISOLATED-world orchestrator. Owns the message bus
 * to both the MAIN-world adapter (via `adapter-client.ts`) and the service
 * worker (via `chrome.runtime` messages), and is the only place the engine
 * loop (ranker + governor + assist/autobuyer) actually runs — rule 5: the
 * service worker owns no loops, this file is where "loop" is allowed to
 * mean something.
 *
 * Also owns crash recovery: the governor's counters (and a little session
 * bookkeeping) are persisted to `storage.session` on an interval and
 * restored on load, so a page reload within the same browser session
 * resumes the risk budget instead of quietly resetting it to zero (which
 * would be a governor bypass, not a convenience).
 */
import browser from 'webextension-polyfill';

import { AssistEngine } from '../engine/assist.js';
import { Governor, type GovernorState } from '../engine/governor.js';
import { rankCandidates, type OpportunityCandidate, type ScoredOpportunity } from '../engine/ranker.js';
import { logger } from '../lib/logger.js';
import { getSession, setSession } from '../lib/storage.js';
import { createPanel, type Panel } from '../ui/panel.js';

import { createAdapterClient } from './adapter-client.js';

import type { Autobuyer, StopReason } from '../engine/autobuyer.js';
import type { AttemptInput, TradeInput } from '../engine/types.js';
import type { PriceSummary } from '../model/prices.js';
import type {
  ActivityEvent,
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
const SESSION_STATE_KEY = 'sl.engine.state.v1';

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
    if (governor?.isKillSwitchActive()) return 'risk';
    return 'live';
  }
  function engineHealthMessage(): string {
    if (!probeOk) return `Bundle probe failed — assist/automation are hard-stopped until adapter.ts is updated.`;
    if (governor?.isKillSwitchActive()) return 'Kill switch active — all actions blocked.';
    return assist ? 'Assist engine active.' : 'Recording. Nothing beyond product telemetry is sent.';
  }

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
  let killSwitchActive = false;

  if (authStatus?.authenticated) {
    const bootstrap = await send<BootstrapResponse>('license.bootstrap');
    if (bootstrap) {
      features = bootstrap.features;
      killSwitchActive = bootstrap.killSwitchActive;
      settingsCache = bootstrap.settings;
    }
  }

  // Crash recovery: resume the governor's counters if this is a reload
  // within the same browsing session, not a brand-new one.
  const savedState = await getSession<GovernorState | null>(SESSION_STATE_KEY, null);
  const governor: Governor | null =
    features.includes('assist.ranker') || AUTOMATION_ENABLED
      ? savedState
        ? Governor.hydrate(settingsCache.governor, savedState)
        : new Governor(settingsCache.governor)
      : null;
  governor?.setKillSwitch(killSwitchActive, killSwitchActive ? 'server kill switch active at bootstrap' : undefined);

  let assist: AssistEngine | null = null;
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

  if (governor && features.includes('assist.ranker')) {
    const filters = (await send<SavedFilter[]>('filters.list')) ?? [];
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
    await refreshSummaries();
    const candidates = buildCandidatesFromTracked();
    rankedCandidates = rankCandidates(candidates, { minEv: settingsCache.targets.minProfitPerSnipe });
    panel.setRanked(rankedCandidates);

    if (autobuyer && !autobuyer.isStopped()) {
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
    panel.setRiskSnapshot(governor.snapshot());
    if (assist) panel.setSessionPnl(assist.sessionPnl);
  }, RISK_UI_TICK_MS);

  // ---- crash recovery: persist governor state to storage.session ----------

  async function persistState(): Promise<void> {
    if (!governor) return;
    await setSession(SESSION_STATE_KEY, governor.serialize());
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

void main();
