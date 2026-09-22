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
 *   - sessionLengthMinutes — wall-clock time since the governor was created
 *                            (a new browser session / extension reload
 *                            resets it — see `serialize`/`hydrate` for how
 *                            `content/index.ts` carries it across a page
 *                            reload instead of a session boundary).
 *   - buyToSearchRatio     — buys / searches must stay under the ratio; a
 *                            human who only ever buys and never searches is
 *                            the single most suspicious shape there is.
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
 * The kill switch (`setKillSwitch(true, reason)`, driven by
 * `lib/license.ts`'s bootstrap/heartbeat and the WS `kill_switch` push,
 * docs/01-architecture.md §3.7) is unconditional and checked first, always —
 * no threshold math can override it.
 */
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
  killSwitchActive: boolean;
  killSwitchReason?: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function freshState(now: number): GovernorState {
  return {
    sessionStartedAt: now,
    actionTimestamps: [],
    searchCount: 0,
    buyCount: 0,
    coinFlow: [],
    cooldownUntil: 0,
    killSwitchActive: false,
  };
}

export class Governor {
  private settings: GovernorSettings;
  private state: GovernorState;
  private readonly now: () => number;

  constructor(settings: GovernorSettings, opts: { now?: () => number; state?: GovernorState } = {}) {
    this.settings = settings;
    this.now = opts.now ?? Date.now;
    this.state = opts.state ?? freshState(this.now());
  }

  setSettings(settings: GovernorSettings): void {
    this.settings = settings;
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
    // until the caller starts a fresh governor (new session) or the
    // cooldown clears (whichever the caller wires up — see docs/06-extension.md).
    const sessionElapsedMinutes = (now - this.state.sessionStartedAt) / 60_000;
    if (sessionElapsedMinutes > this.settings.sessionLengthMinutes) {
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
