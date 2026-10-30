/*
 * auto-clear-sold.ts — the sold cards cleared off the trader's transfer
 * list on their own, every ten minutes, so a full list of sold cards never
 * stops the bot (or Gallery mode's cards on their way from the club) from
 * listing more. The Nova AI page's own Clear sold button stays: the trader
 * can clear at any time, and this runs between presses.
 *
 * `tick` is called every so often (content/index.ts); every `everyMs` it
 * looks at the transfer list as EA's page last showed it (lib/transfer-
 * list.ts) and, when sold cards sit on it, runs EA's own Clear Sold through
 * the same path as the button (content/transfer-tools.ts). A list with no
 * sold cards, or one not seen yet, costs EA no request. Never two at once.
 * No chrome APIs.
 */

/** How often the sold cards are cleared. */
export const AUTO_CLEAR_SOLD_EVERY_MS = 10 * 60_000;

export interface AutoClearSoldStatus {
  everyMs: number;
  /** When the sold cards were last cleared by this (ms since the epoch),
   * null before the first. */
  lastAt: number | null;
  /** What the last run did, in the trader's words; null before the first. */
  lastResult: { ok: boolean; message: string } | null;
  /** When the list is next looked at. */
  nextAt: number;
  /** A clear is under way now. */
  busy: boolean;
}

export interface AutoClearSoldOptions {
  /** How many sold cards the list shows now; null when the list has not
   * been seen yet. */
  sold: () => number | null;
  /** EA's Clear Sold, with how many sold cards the list showed. */
  clear: (count: number) => Promise<{ ok: boolean; message: string }>;
  now?: () => number;
  everyMs?: number;
}

export interface AutoClearSold {
  /** Clears the sold cards when the interval is up and there are any. */
  tick(): void;
  status(): AutoClearSoldStatus;
}

export function createAutoClearSold(opts: AutoClearSoldOptions): AutoClearSold {
  const now = opts.now ?? Date.now;
  const everyMs = opts.everyMs ?? AUTO_CLEAR_SOLD_EVERY_MS;
  // The first look is a full interval after the page loaded: the trader's
  // own press, if any, comes first.
  let checkedAt = now();
  let lastAt: number | null = null;
  let lastResult: AutoClearSoldStatus['lastResult'] = null;
  let busy = false;

  return {
    tick() {
      const t = now();
      if (busy || t - checkedAt < everyMs) return;
      checkedAt = t;
      const sold = opts.sold();
      if (sold === null || sold <= 0) return;
      busy = true;
      void opts
        .clear(sold)
        .then(
          (result) => {
            lastResult = result;
          },
          (err: unknown) => {
            lastResult = { ok: false, message: `Sold cards not cleared: ${String(err)}` };
          },
        )
        .finally(() => {
          lastAt = t;
          busy = false;
        });
    },
    status() {
      return { everyMs, lastAt, lastResult, nextAt: checkedAt + everyMs, busy };
    },
  };
}
