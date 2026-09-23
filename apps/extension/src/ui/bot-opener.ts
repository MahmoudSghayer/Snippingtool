/*
 * bot-opener.ts — lets surfaces other than EA's navigation open the Sniping
 * Bot page: the in-page panel, and the userscript's SL drawer and
 * Tampermonkey menu. `content/index.ts` registers the page once it exists.
 */
let opener: (() => void) | null = null;
const listeners = new Set<(available: boolean) => void>();

export function setBotPageOpener(open: (() => void) | null): void {
  opener = open;
  listeners.forEach((cb) => cb(open != null));
}

/** Opens the page; false when there is none (the listable build, or before
 * the content script has finished starting). */
export function openBotPage(): boolean {
  opener?.();
  return opener != null;
}

export function onBotPageAvailable(cb: (available: boolean) => void): void {
  listeners.add(cb);
  cb(opener != null);
}
