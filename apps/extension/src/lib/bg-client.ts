/*
 * bg-client.ts — the same typed `chrome.runtime.sendMessage` wrapper
 * `content/index.ts` uses, shared with `popup/` and `options/` so all three
 * UI surfaces talk to the service worker the same way.
 */
import browser from 'webextension-polyfill';

import type { BackgroundResponse } from '@sl/shared';

/** Throws on an explicit `{ ok: false }` response (the caller decides what
 * to show, e.g. "wrong password") but returns `null` for a dead/unreachable
 * service worker rather than throwing, since that is a transient condition
 * every caller should treat the same way (retry, or "extension reloading"). */
export async function send<T = unknown>(type: string, payload?: unknown): Promise<T | null> {
  let res: BackgroundResponse | undefined;
  try {
    res = (await browser.runtime.sendMessage({ type, payload })) as BackgroundResponse | undefined;
  } catch {
    return null;
  }
  if (!res) return null;
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}
