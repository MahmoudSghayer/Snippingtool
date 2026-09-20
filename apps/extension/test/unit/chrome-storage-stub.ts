// QA suite helper (owned by the Testing & QA agent — see docs/12-testing.md).
// Not a test file itself; imported by test/unit/*.test.ts files that
// exercise `src/lib/storage.ts` (and anything built on it — auth.ts,
// license.ts, settings.ts, telemetry.ts) through `webextension-polyfill`'s
// `browser.storage.*`.
//
// The shared `test/setup.ts` fixture's `chrome.storage.local`/`.session`
// (`MemoryStorageArea`) exposes a *promise-returning* `get`/`set`/`remove`
// (`async get(keys) { ... }`), which is the shape MV3's own native
// `chrome.storage` API has. But `webextension-polyfill` — the library
// `src/lib/storage.ts` actually calls through (`import browser from
// 'webextension-polyfill'`) — always treats `globalThis.chrome.*` as the
// older *callback-style* API and always appends its own callback as an
// extra argument (`target.get(keys, callback)`), regardless of what the
// real Chrome runtime supports; that is the whole point of the polyfill.
// `MemoryStorageArea.get(keys)` silently ignores that extra callback
// argument and returns a promise nothing awaits, so the callback is never
// invoked and webextension-polyfill's wrapper promise never resolves —
// any test that awaits a `browser.storage.*` call against the shared
// fixture hangs until the suite's hookTimeout/testTimeout. Confirmed by
// isolating a plain `getOrCreateInstallKey()` round trip against the
// unmodified fixture (times out) vs. against this stub (resolves
// immediately) while writing this suite — see docs/12-testing.md "Defects
// found" (filed against apps/extension/test/setup.ts, not fixed here per
// this agent's file ownership: only apps/extension/test/unit/** is ours).
//
// This installs a callback-compatible replacement for `chrome.storage.local`
// and `.session` for the duration of one test file, restoring the original
// object afterwards so it never leaks into other test files that rely on
// the original (promise-style) fixture.
import { afterEach, beforeEach } from 'vitest';

type StorageKeys = string | string[] | Record<string, unknown> | null | undefined;

class CallbackStorageArea {
  private data = new Map<string, unknown>();

  // `callback` is optional and defensively defaulted below: real Chrome
  // (and this repo's webextension-polyfill version) omits it for some
  // storage methods depending on their declared arg-count metadata, calling
  // the method fire-and-forget instead.

  get(keys: StorageKeys, callback?: (result: Record<string, unknown>) => void): void {
    let list: string[];
    if (keys == null) list = [...this.data.keys()];
    else if (typeof keys === 'string') list = [keys];
    else if (Array.isArray(keys)) list = keys;
    else list = Object.keys(keys);

    const out: Record<string, unknown> = {};
    for (const k of list) if (this.data.has(k)) out[k] = this.data.get(k);
    callback?.(out);
  }

  set(items: Record<string, unknown>, callback?: () => void): void {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
    callback?.();
  }

  remove(keys: string | string[], callback?: () => void): void {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
    callback?.();
  }

  clear(callback?: () => void): void {
    this.data.clear();
    callback?.();
  }
}

/** Call once at the top of a `describe` block. Installs fresh, empty,
 * callback-compatible storage areas before every test and restores the
 * original `chrome.storage` object afterwards. */
export function useRealChromeStorage(): void {
  let original: unknown;

  beforeEach(() => {
    const g = globalThis as unknown as { chrome: { storage: unknown } };
    original = g.chrome.storage;
    g.chrome.storage = {
      local: new CallbackStorageArea(),
      session: new CallbackStorageArea(),
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    };
  });

  afterEach(() => {
    const g = globalThis as unknown as { chrome: { storage: unknown } };
    g.chrome.storage = original;
  });
}
