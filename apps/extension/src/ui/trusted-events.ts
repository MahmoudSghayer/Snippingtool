/*
 * trusted-events.ts — user-action listeners that only a real user can fire.
 *
 * The extension's UI on EA's page (the bot page and the userscript's
 * drawer) shares the page with EA's scripts and anything
 * else running there. A closed shadow root keeps them from reaching in, and
 * this is the second half: an event a script made (`el.click()`,
 * `dispatchEvent(new Event('change'))`) has `isTrusted === false`, so a page
 * script that did get hold of an element still cannot tick the risk
 * acknowledgment, change a limit, or press Start. Every click, change,
 * input, submit and keydown handler in that UI goes through `onTrusted`.
 */

type TrustCheck = (event: Event) => boolean;

const browserTrust: TrustCheck = (event) => event.isTrusted;
let trustCheck: TrustCheck = browserTrust;

/** Adds `handler` for `type` on `target`, ignoring events a script made. */
export function onTrusted<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  target.addEventListener(
    type,
    (event) => {
      if (!trustCheck(event)) return;
      handler(event as HTMLElementEventMap[K]);
    },
    options,
  );
}

/**
 * Tests only: jsdom marks every event a test dispatches untrusted, so unit
 * tests of these handlers replace the check (and put it back with
 * `resetTrustCheckForTests`). Module state, not a global: nothing on the
 * page can reach it.
 */
export function setTrustCheckForTests(check: TrustCheck): void {
  trustCheck = check;
}

export function resetTrustCheckForTests(): void {
  trustCheck = browserTrust;
}
