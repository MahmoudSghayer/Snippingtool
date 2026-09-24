/*
 * governor.ts — the safety budget. Sits between every decision and every
 * action (docs/01-architecture.md, "safety governor"): `engine/assist.ts`
 * and `engine/autobuyer.ts` call `governor.allow(action)` before every
 * single `adapter.act()`, never once per session. This is a first-class
 * component, not a rate limiter bolted on afterward — the product's whole
 * pitch is "we stop you before you look like a bot", never "undetectable".
 *
 * Four thresholds, all from `GovernorSettings` (packages/shared, user-tunable
 * within an admin-set ceiling — `GOVERNOR_ABSOLUTE_LIMITS` is the hard
 * floor/ceiling this file itself refuses to exceed regardless of what
 * settings it's handed):
 *
 *   - actionsPerHour       — sliding one-hour window over every action
 *                            (search + buy both count; a lot of very fast
 *                            searching is exactly the shape of behaviour
 *                            that gets flagged, not just buying).
 *   - sessionLengthMinutes — wall-clock time since the session started
 *                            (a new browser session / extension reload
 *                            resets it — see `serialize`/`hydrate` for how
 *                            `content/index.ts` carries it across a page
 *                            reload instead of a session boundary). Once it
 *                            trips and its cooldown has elapsed, the next
 *                            `allow()` starts a new session (`resetSession`).
 *   - buyToSearchRatio     — buys / searches must stay under the ratio; a
 *                            human who only ever buys and never searches is
 *                            the single most suspicious shape there is.
 *                            Searches reach it two ways: engine-issued ones
 *                            pass `allow({kind:'search'})` (engine/search.ts's
 *                            `governedSearch`), and ones the human runs in
 *                            EA's own UI — which the extension only observes —
 *                            are counted by `recordObservedSearch()`.
 *   - maxCoinFlowPerHour   — coins spent on `buy` actions, sliding one-hour
 *                            window (added to `GovernorSettings` alongside
 *                            the other three — see packages/shared/src/
 *                            schemas/settings.ts).
 *
 * `actionsPerHour` and `sessionLengthMinutes` are **hard stops**: exceeding
 * either puts the governor into a cooldown (`cooldownSeconds`) during which
 * *every* action is denied, not just the one that tripped it. `buyToSearchRatio`
 * and `maxCoinFlowPerHour` are **soft denies**: only the one action that
 * would breach the threshold is denied, because both are self-correcting
 * (more searching lowers the ratio; waiting an hour drains the coin-flow
 * window) and denying everything else while they cool down would just be a
 * second, redundant cooldown.
 *
 * Settings are clamped to `GOVERNOR_ABSOLUTE_LIMITS` on the way in (the
 * constructor, `setSettings`, and therefore `hydrate`): a cached settings
 * document or a hand-edited `storage.local` value must never be able to
 * loosen the governor past the absolute ceiling.
 *
 * The kill switch (`setKillSwitch(true, reason)`, driven by
 * `lib/license.ts`'s bootstrap/heartbeat and the WS `kill_switch` push,
 * docs/01-architecture.md §3.7) is unconditional and checked first, always —
 * no threshold math can override it.
 */
import { DEFAULT_GOVERNOR_SETTINGS, GOVERNOR_ABSOLUTE_LIMITS } from '@sl/shared';

import type { GovernorSettings, RiskEventKind } from '@sl/shared';

export type ActionKind = 'search' | 'buy';

export interface ActionRequest {
  kind: ActionKind;
  /** Coins the `buy` would spend — required for `buy`, ignored for `search`. */
  coins?: number;
}

export interface RiskBudgetEventInput {
  kind: RiskEventKind;
  value: number;
  threshold: number;
}

export interface GovernorDecision {
  allowed: boolean;
  reason?: RiskEventKind;
  /** Human-readable detail for the panel/log, not sent to the server (the
   * server-bound shape is `RiskBudgetEventInput`, occurredAt/deviceId/
   * sessionId added by the caller — see `content/index.ts`). */
  detail?: string;
  /** Every check this decision touched, denied or not — the caller decides
   * which of these to actually flush as telemetry (see `snapshot()` for the
   * always-on "current utilization" view the risk meter reads instead). */
  events: RiskBudgetEventInput[];
}

export interface RiskSnapshot {
  actionsLastHour: number;
  actionsPerHourLimit: number;
  sessionElapsedMinutes: number;
  sessionLengthLimitMinutes: number;
  buyToSearchRatio: number;
  buyToSearchRatioLimit: number;
  coinFlowLastHour: number;
  coinFlowLimit: number;
  inCooldown: boolean;
  cooldownRemainingMs: number;
  killSwitchActive: boolean;
}

/** Everything needed to resume a governor's counters across a page reload
 * within the same browsing session — see `content/index.ts`'s crash
 * recovery (`storage.session`), and docs/01-architecture.md's note that the
 * engine loop (and therefore the governor) lives in the content script,
 * never the service worker. */
export interface GovernorState {
  sessionStartedAt: number;
  actionTimestamps: number[];
  searchCount: number;
  buyCount: number;
  coinFlow: Array<{ at: number; coins: number }>;
  cooldownUntil: number;
  /** Set when the session-length hard stop trips; the first `allow()` after
   * its cooldown starts a new session. Optional so state saved by an older
   * build still hydrates. */
  sessionExpired?: boolean;
  killSwitchActive: boolean;
  killSwitchReason?: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/** EA's search response reaches the content script more than once — the
 * patched XHR and `emitAuctionInfo` both report it (src/main/adapter.ts) —
 * so observed reports this close to the last counted search are treated as
 * the same search. Nobody runs two real searches in EA's UI within 1.5 s,
 * and erring towards *under*-counting searches only makes the ratio
 * stricter, never looser. */
export const OBSERVED_SEARCH_DEDUPE_MS = 1_500;

function clampSetting(key: keyof GovernorSettings, value: number): number {
  // A non-finite value (a corrupt cache) has no meaningful clamp — fall
  // back to the shipped default rather than letting NaN disable a check
  // (every `x > NaN` comparison is false).
  if (!Number.isFinite(value)) return DEFAULT_GOVERNOR_SETTINGS[key];
  const { min, max } = GOVERNOR_ABSOLUTE_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

/** Clamp every threshold into `GOVERNOR_ABSOLUTE_LIMITS`. */
export function clampGovernorSettings(settings: GovernorSettings): GovernorSettings {
  return {
    actionsPerHour: clampSetting('actionsPerHour', settings.actionsPerHour),
    sessionLengthMinutes: clampSetting('sessionLengthMinutes', settings.sessionLengthMinutes),
    buyToSearchRatio: clampSetting('buyToSearchRatio', settings.buyToSearchRatio),
    cooldownSeconds: clampSetting('cooldownSeconds', settings.cooldownSeconds),
    maxCoinFlowPerHour: clampSetting('maxCoinFlowPerHour', settings.maxCoinFlowPerHour),
  };
}

function freshState(now: number): GovernorState {
  return {
    sessionStartedAt: now,
    actionTimestamps: [],
    searchCount: 0,
    buyCount: 0,
    coinFlow: [],
    cooldownUntil: 0,
    sessionExpired: false,
    killSwitchActive: false,
  };
}

export class Governor {
  private settings: GovernorSettings;
  private state: GovernorState;
  private readonly now: () => number;
  /** When the last search was counted (gated or observed) — in memory only;
   * losing it on reload costs at most one extra counted search. */
  private lastSearchAt = Number.NEGATIVE_INFINITY;
  /** Engine-issued searches currently awaiting their response. While any is
   * in flight, observed search responses belong to it (it was already
   * counted by `allow`) and are not counted again. */
  private engineSearchesInFlight = 0;

  constructor(settings: GovernorSettings, opts: { now?: () => number; state?: GovernorState } = {}) {
    this.settings = clampGovernorSettings(settings);
    this.now = opts.now ?? Date.now;
    this.state = opts.state ?? freshState(this.now());
  }

  setSettings(settings: GovernorSettings): void {
    this.settings = clampGovernorSettings(settings);
  }

  getSettings(): GovernorSettings {
    return this.settings;
  }

  /** Server kill switch (bootstrap/heartbeat/WS push) — unconditional and
   * immediate, regardless of build target (docs/01-architecture.md, §3.7). */
  setKillSwitch(active: boolean, reason?: string): void {
    this.state.killSwitchActive = active;
    this.state.killSwitchReason = active ? reason : undefined;
  }

  isKillSwitchActive(): boolean {
    return this.state.killSwitchActive;
  }

  private prune(now: number): void {
    const cutoff = now - ONE_HOUR_MS;
    this.state.actionTimestamps = this.state.actionTimestamps.filter((t) => t > cutoff);
    this.state.coinFlow = this.state.coinFlow.filter((c) => c.at > cutoff);
  }

  /** Start a new session: the session clock and the per-session buy/search
   * counters start over. Deliberately leaves the cooldown, the sliding
   * one-hour windows (`actionsPerHour`, `maxCoinFlowPerHour`) and the kill
   * switch alone — a session reset (automatic, or a future UI button) must
   * never be a way around those. */
  resetSession(now: number = this.now()): void {
    this.state.sessionStartedAt = now;
    this.state.searchCount = 0;
    this.state.buyCount = 0;
    this.state.sessionExpired = false;
  }

  /** Count a search the human ran in EA's own UI, which the extension only
   * observed (assist mode's normal shape). Never gates — the search already
   * happened — but it does count toward `searchCount` and `actionsPerHour`,
   * or assist mode would have every buy after the first denied
   * `buy_search_ratio`. Returns whether it was counted: duplicate reports of
   * one search (`OBSERVED_SEARCH_DEDUPE_MS`) and the response of an
   * engine-issued search already counted by `allow` are not. */
  recordObservedSearch(now: number = this.now()): boolean {
    if (this.engineSearchesInFlight > 0) return false;
    if (now - this.lastSearchAt < OBSERVED_SEARCH_DEDUPE_MS) return false;
    this.prune(now);
    this.state.actionTimestamps.push(now);
    this.state.searchCount++;
    this.lastSearchAt = now;
    return true;
  }

  /** Bracket an engine-issued search's adapter call (engine/search.ts) so
   * its observed response is attributed to it instead of counted twice. */
  beginEngineSearch(): void {
    this.engineSearchesInFlight++;
  }

  endEngineSearch(now: number = this.now()): void {
    this.engineSearchesInFlight = Math.max(0, this.engineSearchesInFlight - 1);
    // A report trailing the call's resolution is still the same search.
    this.lastSearchAt = now;
  }

  private hardStop(now: number, kind: RiskEventKind, value: number, threshold: number, events: RiskBudgetEventInput[]): GovernorDecision {
    this.state.cooldownUntil = now + this.settings.cooldownSeconds * 1000;
    events.push({ kind, value, threshold });
    events.push({ kind: 'hard_stop', value, threshold });
    return { allowed: false, reason: 'hard_stop', detail: `${kind} exceeded — cooling down`, events };
  }

  /** The one gate every `adapter.act()` call must pass through. */
  allow(action: ActionRequest, now: number = this.now()): GovernorDecision {
    const events: RiskBudgetEventInput[] = [];

    if (this.state.killSwitchActive) {
      events.push({ kind: 'kill_switch', value: 1, threshold: 0 });
      return { allowed: false, reason: 'kill_switch', detail: this.state.killSwitchReason, events };
    }

    if (now < this.state.cooldownUntil) {
      events.push({ kind: 'hard_stop', value: this.state.cooldownUntil - now, threshold: 0 });
      return { allowed: false, reason: 'hard_stop', detail: 'in cooldown', events };
    }

    this.prune(now);

    // Session length is a hard stop: once tripped, every action is denied
    // for the cooldown. The first action after that cooldown starts a new
    // session — without this, the elapsed time stays over the limit and the
    // stop re-trips forever (docs/06-extension.md §5).
    if (this.state.sessionExpired) this.resetSession(now);
    const sessionElapsedMinutes = (now - this.state.sessionStartedAt) / 60_000;
    if (sessionElapsedMinutes > this.settings.sessionLengthMinutes) {
      this.state.sessionExpired = true;
      return this.hardStop(now, 'session_length', sessionElapsedMinutes, this.settings.sessionLengthMinutes, events);
    }

    // actionsPerHour is a hard stop: it is checked against what the count
    // *would become* if this action were allowed, so the limit is never
    // exceeded even by one.
    const projectedActions = this.state.actionTimestamps.length + 1;
    if (projectedActions > this.settings.actionsPerHour) {
      return this.hardStop(now, 'actions_per_hour', projectedActions, this.settings.actionsPerHour, events);
    }

    if (action.kind === 'buy') {
      const projectedBuys = this.state.buyCount + 1;
      const ratio = projectedBuys / Math.max(this.state.searchCount, 1);
      if (ratio > this.settings.buyToSearchRatio) {
        events.push({ kind: 'buy_search_ratio', value: ratio, threshold: this.settings.buyToSearchRatio });
        return { allowed: false, reason: 'buy_search_ratio', detail: 'too many buys relative to searches', events };
      }

      const coins = action.coins ?? 0;
      const flowLastHour = this.state.coinFlow.reduce((sum, c) => sum + c.coins, 0);
      const projectedFlow = flowLastHour + coins;
      if (projectedFlow > this.settings.maxCoinFlowPerHour) {
        events.push({ kind: 'coin_flow', value: projectedFlow, threshold: this.settings.maxCoinFlowPerHour });
        return { allowed: false, reason: 'coin_flow', detail: 'coin flow/hour budget exhausted', events };
      }
    }

    // Allowed — record it.
    this.state.actionTimestamps.push(now);
    if (action.kind === 'search') {
      this.state.searchCount++;
      this.lastSearchAt = now;
    } else {
      this.state.buyCount++;
      if (action.coins) this.state.coinFlow.push({ at: now, coins: action.coins });
    }

    return { allowed: true, events };
  }

  /** Current utilization against every threshold — what the panel/popup's
   * risk budget meter reads (docs/01-architecture.md, "visible risk budget
   * meter"). Never denies anything itself; `allow()` is the only gate. */
  snapshot(now: number = this.now()): RiskSnapshot {
    this.prune(now);
    const sessionElapsedMinutes = (now - this.state.sessionStartedAt) / 60_000;
    const coinFlowLastHour = this.state.coinFlow.reduce((sum, c) => sum + c.coins, 0);
    const ratio = this.state.buyCount / Math.max(this.state.searchCount, 1);
    return {
      actionsLastHour: this.state.actionTimestamps.length,
      actionsPerHourLimit: this.settings.actionsPerHour,
      sessionElapsedMinutes,
      sessionLengthLimitMinutes: this.settings.sessionLengthMinutes,
      buyToSearchRatio: ratio,
      buyToSearchRatioLimit: this.settings.buyToSearchRatio,
      coinFlowLastHour,
      coinFlowLimit: this.settings.maxCoinFlowPerHour,
      inCooldown: now < this.state.cooldownUntil,
      cooldownRemainingMs: Math.max(0, this.state.cooldownUntil - now),
      killSwitchActive: this.state.killSwitchActive,
    };
  }

  serialize(): GovernorState {
    return { ...this.state, actionTimestamps: [...this.state.actionTimestamps], coinFlow: [...this.state.coinFlow] };
  }

  static hydrate(settings: GovernorSettings, state: GovernorState, opts: { now?: () => number } = {}): Governor {
    return new Governor(settings, { ...opts, state });
  }
}
