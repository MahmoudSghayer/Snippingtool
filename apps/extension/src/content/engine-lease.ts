/*
 * engine-lease.ts — this tab's side of the per-profile engine lease
 * (background/engine-lease.ts has the why). Only the tab holding the lease
 * runs an engine: the assist hotkeys, the autobuyer and the Sniping Bot all
 * ask `isHeld()` before acting, and the governor state is saved only by the
 * holder. Chrome-free (the caller passes the background calls in), so the
 * userscript bundles it unchanged.
 *
 * Gaining the lease is not enough to act: the budgets the previous holder
 * saved must be loaded first (`onGain`), or this tab would act on the stale
 * copy it read at page load. If they cannot be loaded, the lease is given
 * straight back (fail closed) and asked for again at the next refresh.
 */

export interface EngineLeaseDeps {
  /** This page load's id (a random UUID). */
  ownerId: string;
  /** background's `engine.lockAcquire`; null when background did not answer. */
  acquire: (ownerId: string) => Promise<{ held: boolean; expiresAt: number } | null>;
  /** background's `engine.lockRelease` (fire and forget). */
  release: (ownerId: string) => void;
  /** Runs on gaining the lease, before it counts as held: load what the
   * previous holder saved. `false` (could not) gives the lease back. */
  onGain?: () => Promise<boolean>;
  /** Runs on losing it (another tab took it after it expired): stop acting. */
  onLose?: () => void;
  now?: () => number;
}

export class EngineLease {
  private held = false;
  private expiresAt = 0;
  private inFlight: Promise<boolean> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: EngineLeaseDeps) {
    this.now = deps.now ?? Date.now;
  }

  get ownerId(): string {
    return this.deps.ownerId;
  }

  /** Whether this tab may act now. Also false once the lease's own expiry
   * has passed without a renewal: by then another tab may hold it. */
  isHeld(): boolean {
    return this.held && this.now() < this.expiresAt;
  }

  /** Acquire or renew. One at a time: a call while one is in flight shares
   * its result. */
  refresh(): Promise<boolean> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const wasHeld = this.held;
    const answer = await this.deps.acquire(this.deps.ownerId).catch(() => null);
    if (!answer) {
      // Background did not answer (the worker is restarting). The lease
      // stored there is still this tab's until it expires, and nobody else
      // can take it before then — but no longer than that.
      if (!this.isHeld()) this.lose(wasHeld);
      return this.isHeld();
    }
    if (!answer.held) {
      this.lose(wasHeld);
      return false;
    }
    // Gained, or regained after lapsing (another tab may have held it in
    // between): load what the last holder saved before acting.
    if (!this.isHeld()) {
      const loaded = await (this.deps.onGain?.() ?? Promise.resolve(true)).catch(() => false);
      if (!loaded) {
        this.lose(wasHeld);
        this.deps.release(this.deps.ownerId);
        return false;
      }
    }
    this.held = true;
    this.expiresAt = answer.expiresAt;
    return true;
  }

  private lose(wasHeld: boolean): void {
    this.held = false;
    if (wasHeld) this.deps.onLose?.();
  }

  /** Gives the lease back (the tab is closing). */
  release(): void {
    const wasHeld = this.held;
    this.held = false;
    if (wasHeld) this.deps.release(this.deps.ownerId);
  }
}

/** What the heartbeat reports for this tab's engine (`engine.state`):
 * `halted` when the kill switch or a failed adapter probe stops every
 * action, `running` while the Sniping Bot or the autobuyer loop runs,
 * `paused` when the user paused the assist chords, otherwise `idle` (assist
 * only acts when the user presses a chord). */
export function engineStateOf(engine: {
  killSwitch: boolean;
  probeOk: boolean;
  automationRunning: boolean;
  assistPaused: boolean;
}): 'idle' | 'running' | 'paused' | 'halted' {
  if (engine.killSwitch || !engine.probeOk) return 'halted';
  if (engine.automationRunning) return 'running';
  if (engine.assistPaused) return 'paused';
  return 'idle';
}
