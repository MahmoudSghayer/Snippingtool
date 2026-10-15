/*
 * pile-refresh.ts — when Nova AI has the web app reload the trader's
 * transfer list (the adapter's `pile` act), so the page's Sold, Unsold and
 * Transfer list counts follow the bot instead of waiting for the user to
 * open EA's Transfer List:
 *
 *   - shortly after each card the bot lists, once EA has it on the market;
 *   - every few minutes while the bot runs or the Nova AI page is open,
 *     since EA only shows a card as sold when the list is loaded again.
 *
 * Each reload is a real request to EA, so never more than one every
 * 30 seconds (the adapter refuses one within 15 s besides), and listings
 * close together share one. The reload's answer only says EA answered: the
 * list itself reaches the counts through passive observation
 * (`onTradePile`, lib/transfer-list.ts). No chrome APIs.
 */

/** How long after a listing to reload: long enough for EA to have it. */
export const PILE_AFTER_LISTING_MS = 2_000;
/** How often to reload while the bot runs or the page is open. */
export const PILE_EVERY_MS = 3 * 60_000;
/** The shortest gap between two reloads. */
export const PILE_MIN_GAP_MS = 30_000;

export interface PileRefresher {
  /** The bot listed a card: reload soon. */
  listed(): void;
  /** Called every so often: reloads when `active` (the bot runs, or the
   * page is open) and the last reload is older than `PILE_EVERY_MS`. */
  tick(active: boolean): void;
  dispose(): void;
}

export interface PileRefresherOptions {
  refresh: () => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createPileRefresher(opts: PileRefresherOptions): PileRefresher {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let last = -Infinity;
  let inFlight = false;
  let timer: { handle: unknown; due: number } | null = null;

  function run(): void {
    if (timer) {
      clearTimer(timer.handle);
      timer = null;
    }
    if (inFlight) return;
    inFlight = true;
    last = now();
    // A failed reload is simply not counted on; the next one tries again.
    void opts
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }

  return {
    listed() {
      const t = now();
      const due = Math.max(t + PILE_AFTER_LISTING_MS, last + PILE_MIN_GAP_MS);
      // One already coming at or before then covers this listing too.
      if (timer && timer.due <= due) return;
      if (timer) clearTimer(timer.handle);
      timer = { due, handle: setTimer(run, due - t) };
    },
    tick(active) {
      if (!active || timer || now() - last < PILE_EVERY_MS) return;
      run();
    },
    dispose() {
      if (timer) clearTimer(timer.handle);
      timer = null;
    },
  };
}
