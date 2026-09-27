/*
 * background-request.ts — content's calls to background, over whatever
 * `sendMessage` the build has (`chrome.runtime` in the extension, the
 * userscript's in-page bus there). Chrome-free, so it is testable.
 *
 * `send` returns null for anything but data: an explicit refusal, and a
 * service worker that did not answer (dead, reloading), alike. That is fine
 * where null means "nothing to show". It is not fine where null would be
 * taken as "nothing saved" and the caller would then save fresh state over
 * the stored one (finding A: the Sniping Bot's hourly budgets). Those
 * callers use `request` or `requireAnswer`, which keep the two apart.
 */
import type { BackgroundResponse } from '@sl/shared';

export type BackgroundAnswer<T> = { ok: true; data: T } | { ok: false };

export interface BackgroundClient {
  request<T = unknown>(type: string, payload?: unknown): Promise<BackgroundAnswer<T>>;
  send<T = unknown>(type: string, payload?: unknown): Promise<T | null>;
  /** The data, or a rejection when background did not answer. */
  requireAnswer<T = unknown>(type: string, payload?: unknown): Promise<T>;
}

export function createBackgroundClient(
  sendMessage: (message: { type: string; payload?: unknown }) => Promise<unknown>,
  warn: (message: string) => void,
): BackgroundClient {
  async function request<T>(type: string, payload?: unknown): Promise<BackgroundAnswer<T>> {
    try {
      const res = (await sendMessage({ type, payload })) as BackgroundResponse | undefined;
      if (!res) {
        warn(`background did not answer '${type}'`); // dead/reloaded service worker
        return { ok: false };
      }
      if (!res.ok) {
        warn(`background rejected '${type}': ${res.error}`);
        return { ok: false };
      }
      return { ok: true, data: res.data as T };
    } catch (err) {
      warn(`sendMessage('${type}') failed: ${String(err)}`);
      return { ok: false };
    }
  }
  return {
    request,
    async send<T>(type: string, payload?: unknown): Promise<T | null> {
      const answer = await request<T>(type, payload);
      return answer.ok ? answer.data : null;
    },
    async requireAnswer<T>(type: string, payload?: unknown): Promise<T> {
      const answer = await request<T>(type, payload);
      if (!answer.ok) throw new Error(`no answer from background to '${type}'`);
      return answer.data;
    },
  };
}
