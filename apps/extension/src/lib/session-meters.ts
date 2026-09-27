/*
 * session-meters.ts — what the session timer, the session budget meter and
 * the daily profit goal show, as data (P0 Task 13). A UI renders these; it
 * never recomputes a number: the inputs are the governor's own snapshot
 * (`Governor.snapshot()`, pushed to background as `governor.snapshotPush`
 * with the user's `budgets.sessionCoinBudget`, read back with
 * `governor.snapshotGet`), and today's realised profit from the trade
 * lifecycle (`lifecycle.todayPnl`) against `targets.dailyProfitGoal`.
 */

export interface SessionMeters {
  /** Session clock against `sessionLengthMinutes`. `fraction` may pass 1. */
  timer: { elapsedMs: number; limitMs: number; fraction: number; label: string };
  /** Coins spent this session against `sessionCoinBudget`; `cap` and
   * `fraction` are null when there is no session budget. */
  spend: { spent: number; cap: number | null; fraction: number | null; label: string };
}

const coins = (n: number) => Math.round(n).toLocaleString('en-US');

/** Minutes as m:ss. */
function clock(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function sessionMeters(
  snapshot: { sessionElapsedMinutes: number; sessionLengthLimitMinutes: number; sessionCoinsSpent?: number },
  sessionCoinBudget: number | null,
): SessionMeters {
  const elapsedMs = Math.max(0, snapshot.sessionElapsedMinutes * 60_000);
  const limitMs = Math.max(0, snapshot.sessionLengthLimitMinutes * 60_000);
  const spent = snapshot.sessionCoinsSpent ?? 0;
  const cap = sessionCoinBudget != null && sessionCoinBudget > 0 ? sessionCoinBudget : null;
  return {
    timer: {
      elapsedMs,
      limitMs,
      fraction: limitMs > 0 ? elapsedMs / limitMs : 0,
      label: `${clock(snapshot.sessionElapsedMinutes)} / ${clock(snapshot.sessionLengthLimitMinutes)}`,
    },
    spend: {
      spent,
      cap,
      fraction: cap == null ? null : spent / cap,
      label: cap == null ? `${coins(spent)} (no cap)` : `${coins(spent)} / ${coins(cap)}`,
    },
  };
}

export interface DailyGoalProgress {
  realised: number;
  goal: number | null;
  /** 0 or more (a loss counts as none); null without a goal. */
  fraction: number | null;
  reached: boolean;
}

export function dailyGoalProgress(realisedToday: number, goal: number | null): DailyGoalProgress {
  if (goal == null || goal <= 0) return { realised: realisedToday, goal: null, fraction: null, reached: false };
  return {
    realised: realisedToday,
    goal,
    fraction: Math.max(0, realisedToday) / goal,
    reached: realisedToday >= goal,
  };
}
