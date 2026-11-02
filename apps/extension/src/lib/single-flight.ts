/*
 * single-flight.ts — wraps an async function so that a call arriving while
 * a previous call is still in flight is dropped instead of starting a
 * second, overlapping run.
 *
 * Pulled out of `content/index.ts`'s `engineTick()` (docs/12-testing.md
 * "Defects found"): `setInterval(() => void engineTick(), AUTOBUYER_TICK_MS)`
 * had no re-entrancy guard, so if one tick was still awaiting
 * `refreshSummaries()` (up to 20 sequential `send('summary', ...)` round
 * trips) and `autobuyer.runCycle(...)` when the next interval fired, a
 * second tick would start over the same tracked auctions and could run a
 * second, overlapping autobuyer cycle. `content/index.ts` is not unit-
 * testable in isolation (it wires up the whole content-script bootstrap),
 * so the guard itself lives here, tested on its own, and `index.ts` just
 * wraps `engineTick` with it.
 */

/** Wraps `fn` so a call made while a previous call's returned promise is
 * still pending resolves immediately to `undefined` instead of invoking
 * `fn` again. The in-flight flag is cleared in a `finally`, so it resets
 * whether `fn` resolves or rejects — a single failing run never wedges the
 * guard closed forever. */
export function singleFlight<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let inFlight = false;
  return async (...args: Args): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await fn(...args);
    } finally {
      inFlight = false;
    }
  };
}

/** Wraps `fn` so a call made while a previous call is still in flight
 * joins it: both get the same promise (and the same result or rejection),
 * and `fn` runs once. The joined call's own arguments are not used. For
 * work whose caller needs the outcome — the Nova AI page's `prepare()`,
 * which must see the bot once it exists — where `singleFlight`'s dropped
 * call would resolve to nothing. */
export function sharedFlight<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: Args): Promise<T> => {
    if (inFlight) return inFlight;
    inFlight = fn(...args).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
