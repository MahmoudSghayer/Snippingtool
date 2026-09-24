/*
 * autobuyer.ts — M3: automation. Only ever present in the `ledger-auto`
 * build (see `engine/autobuyer-loader.*.ts` and `scripts/build.mjs` for the
 * build-time exclusion guarantee — `ledger`'s bundle never contains this
 * module at all, not even dead code) and only ever reachable at runtime
 * when `import.meta.env.VITE_AUTOMATION === '1'`.
 *
 * Consumes `engine/ranker.ts`'s ranked candidates, calls
 * `governor.allow()` before every single attempt (never once per cycle),
 * then drives `adapter.act('buy', ...)`. Stops immediately — mid-cycle,
 * discarding remaining candidates — on a probe failure or a `shape`
 * message from the adapter (docs/01-architecture.md, §3.5): those mean the
 * assumed service-layer shape (or the passive market payload shape) no
 * longer matches reality, and continuing to act on stale assumptions is
 * exactly the failure mode this whole architecture exists to avoid.
 */
import { ACT_ERROR, isAdapterRefusal } from '../lib/act-auth.js';
import { backoffMs, sleep } from '../lib/http.js';

import type { Governor, GovernorDecision } from './governor.js';
import type { ScoredOpportunity } from './ranker.js';
import type { AttemptInput, TradeInput } from './types.js';
import type { AdapterClient } from '../content/adapter-client.js';

export interface AutobuyerDeps {
  governor: Governor;
  adapter: AdapterClient;
  onAttempt: (input: AttemptInput) => void;
  onTrade: (input: TradeInput) => void;
  /** Retries for a single candidate before moving on — the assumed service
   * layer can transiently fail (network blip inside the page, a modal in
   * the way) without the auction itself being gone. */
  maxRetriesPerCandidate?: number;
  /** Total coins this autobuyer instance may spend across its lifetime
   * (`budgets.sessionCoinBudget`, `@sl/shared`) — independent of, and in
   * addition to, the governor's own `maxCoinFlowPerHour`. `null` = no cap
   * beyond the governor's. */
  sessionCoinBudget?: number | null;
}

export type StopReason = 'probe_failure' | 'shape_mismatch' | 'manual' | 'session_budget_exhausted';

/** A sold-out / no-longer-available auction is not a retryable failure —
 * matching these error strings against the ASSUMED SHAPE's rejection
 * messages avoids burning retries (and governor-visible actions) on an
 * auction that is simply gone. Adjust this list on day one alongside
 * `adapter.ts`'s ASSUMED SHAPE once real error text is known. */
const NON_RETRYABLE_PATTERN = /sold|no longer available|expired|not found/i;


export class Autobuyer {
  private running = false;
  private stopped = false;
  private stopReason: StopReason | null = null;
  private stopDetail: string | null = null;
  private coinsSpent = 0;

  private readonly unsubscribeProbe: () => void;
  private readonly unsubscribeShape: () => void;

  constructor(private readonly deps: AutobuyerDeps) {
    this.unsubscribeProbe = deps.adapter.onProbe((status) => {
      if (!status.ok) this.stop('probe_failure', status.reason ?? 'bundle probe failed');
    });
    this.unsubscribeShape = deps.adapter.onShape((reason) => {
      this.stop('shape_mismatch', reason);
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getStopReason(): { reason: StopReason; detail: string } | null {
    return this.stopped && this.stopReason ? { reason: this.stopReason, detail: this.stopDetail ?? '' } : null;
  }

  stop(reason: StopReason, detail: string): void {
    this.stopped = true;
    this.stopReason = reason;
    this.stopDetail = detail;
    this.running = false;
  }

  dispose(): void {
    this.unsubscribeProbe();
    this.unsubscribeShape();
  }

  /** Runs one pass over the given (already-ranked) candidates, attempting
   * each until the list is exhausted, the session budget runs out, or a
   * stop condition fires. Returns the number of successful buys. */
  async runCycle(candidates: ScoredOpportunity[]): Promise<number> {
    if (this.stopped) return 0;
    this.running = true;
    let successes = 0;

    for (const candidate of candidates) {
      if (this.stopped) break;
      // Never attempt what the adapter already said it cannot buy (the
      // ranker drops these too): no governor charge, no failed attempt.
      if (candidate.buyable === false) continue;

      if (this.deps.sessionCoinBudget != null && this.coinsSpent + candidate.price > this.deps.sessionCoinBudget) {
        continue; // try a cheaper candidate rather than stopping the whole cycle
      }

      const decision = this.deps.governor.allow({ kind: 'buy', coins: candidate.price });
      if (!decision.allowed) {
        this.deps.onAttempt({
          resourceId: candidate.resourceId,
          tradeId: candidate.tradeId,
          targetPrice: candidate.price,
          listedPrice: candidate.price,
          outcome: 'blocked',
          latencyMs: null,
          errorCode: decision.reason ?? 'blocked',
        });
        // A hard stop or kill switch means every subsequent attempt this
        // cycle would be denied too — stop the cycle, not just this candidate.
        if (decision.reason === 'hard_stop' || decision.reason === 'kill_switch') break;
        continue;
      }

      const ok = await this.attemptWithRetry(candidate, decision);
      if (ok) {
        this.coinsSpent += candidate.price;
        successes++;
      }
    }

    this.running = false;
    return successes;
  }

  private recordSuccess(candidate: ScoredOpportunity, latencyMs: number): void {
    this.deps.onAttempt({
      resourceId: candidate.resourceId,
      tradeId: candidate.tradeId,
      targetPrice: candidate.price,
      listedPrice: candidate.price,
      outcome: 'success',
      latencyMs,
      errorCode: null,
    });
    this.deps.onTrade({ tradeId: candidate.tradeId, resourceId: candidate.resourceId, buyPrice: candidate.price });
  }

  private async attemptWithRetry(candidate: ScoredOpportunity, decision: GovernorDecision): Promise<boolean> {
    const maxRetries = this.deps.maxRetriesPerCandidate ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.stopped) return false;

      const result = await this.deps.adapter.buy(candidate.tradeId, candidate.price);

      if (result.ok) {
        this.recordSuccess(candidate, result.latencyMs);
        return true;
      }

      if (result.error === ACT_ERROR.timeoutUnknown) {
        // It reached EA, which had not answered in time: it may have
        // bought. Never retried (a retry could buy twice), still charged to
        // the governor, and settled by EA's late answer if one comes.
        this.deps.onAttempt({
          resourceId: candidate.resourceId,
          tradeId: candidate.tradeId,
          targetPrice: candidate.price,
          listedPrice: candidate.price,
          outcome: 'attempted',
          latencyMs: result.latencyMs,
          errorCode: ACT_ERROR.timeoutUnknown,
        });
        void result.late?.then((late) => {
          if (!late.ok) return;
          this.coinsSpent += candidate.price;
          this.recordSuccess(candidate, late.latencyMs);
        });
        return false;
      }

      // The adapter's own refusals (lib/act-auth.ts): it never called EA,
      // and asking again cannot change the answer. A failed attempt, not a
      // retry. If nothing of this candidate reached EA (a refusal on the
      // first try), the governor gets back what it charged.
      const refused = isAdapterRefusal(result.error);
      if (refused && attempt === 0) this.deps.governor.refund(decision);
      const nonRetryable = !refused && NON_RETRYABLE_PATTERN.test(result.error ?? '');
      const isLastAttempt = attempt === maxRetries || refused;
      this.deps.onAttempt({
        resourceId: candidate.resourceId,
        tradeId: candidate.tradeId,
        targetPrice: candidate.price,
        listedPrice: candidate.price,
        outcome: nonRetryable ? 'too_slow' : isLastAttempt ? 'failed' : 'error',
        latencyMs: result.latencyMs,
        errorCode: result.error ?? 'unknown_error',
      });

      if (nonRetryable || isLastAttempt) return false;
      await sleep(backoffMs(attempt));
    }
    return false;
  }
}
