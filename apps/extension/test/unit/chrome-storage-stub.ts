// QA suite helper (owned by the Testing & QA agent — see docs/12-testing.md).
// Not a test file itself; imported by test/unit/*.test.ts files that
// exercise `src/lib/storage.ts` (and anything built on it — auth.ts,
// license.ts, settings.ts, telemetry.ts) through `webextension-polyfill`'s
// `browser.storage.*`.
//
// The shared `test/setup.ts` fixture's `chrome.storage.local`/`.session`
// (`MemoryStorageArea`) exposes a *promise-returning* `get`/`set`/`remove`
// (`async get(keys) { ... }`). That is the right shape for `.session`
// (`webextension-polyfill`'s static API metadata predates MV3 session
// storage, so `browser.storage.session.*` passes straight through to
// `chrome.storage.session.*` unwrapped — real Chrome's session storage is
// natively promise-based with no callback). But it is the *wrong* shape for
// `.local`: `webextension-polyfill` — the library `src/lib/storage.ts`
// actually calls through (`import browser from 'webextension-polyfill'`) —
// *does* have `.local` in its metadata table and always wraps it as the
// older callback-style API, appending its own callback as an extra argument
// (`target.get(keys, callback)`) regardless of what the real runtime
// supports. `MemoryStorageArea.get(keys)` silently ignores that extra
// callback argument and returns a promise nothing awaits, so the callback
// is never invoked and webextension-polyfill's wrapper promise for `.local`
// never resolves — any test that awaits a `browser.storage.local.*` call
// against the shared fixture hangs until the suite's hookTimeout/
// testTimeout. Confirmed by isolating a plain `getOrCreateInstallKey()`
// round trip against the unmodified fixture (times out) vs. against this
// stub (resolves immediately) while writing this suite — see
// docs/12-testing.md "Defects found" (filed against
// apps/extension/test/setup.ts, not fixed here per this agent's file
// ownership: only apps/extension/test/unit/** is ours).
//
// This installs a *hybrid* replacement for `chrome.storage.local` and
// `.session` for the duration of one test file — one implementation that
// serves both calling conventions (invokes a callback when given one, for
// `.local` via the polyfill's wrapping; returns a promise when called
// without one, for `.session`'s unwrapped pass-through) — restoring the
// original object afterwards so it never leaks into other test files that
// rely on the original (promise-only) fixture.
import { afterEach, beforeEach } from 'vitest';

type StorageKeys = string | string[] | Record<string, unknown> | null | undefined;

class HybridStorageArea {
  private data = new Map<string, unknown>();

  // Every method: with a callback, invokes it (webextension-polyfill's
  // wrapped `.local` calling convention) and returns nothing meaningful;
  // without one, returns a promise (the raw, unwrapped `.session` calling
  // convention real MV3 Chrome uses natively).

  get(keys: StorageKeys, callback?: (result: Record<string, unknown>) => void): void | Promise<Record<string, unknown>> {
    let list: string[];
    if (keys == null) list = [...this.data.keys()];
    else if (typeof keys === 'string') list = [keys];
    else if (Array.isArray(keys)) list = keys;
    else list = Object.keys(keys);

    const out: Record<string, unknown> = {};
    for (const k of list) if (this.data.has(k)) out[k] = this.data.get(k);
    if (callback) {
      callback(out);
      return;
    }
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>, callback?: () => void): void | Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  }

  remove(keys: string | string[], callback?: () => void): void | Promise<void> {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  }

  clear(callback?: () => void): void | Promise<void> {
    this.data.clear();
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  }
}

/** Call once at the top of a `describe` block. Installs empty,
 * callback-compatible storage areas before every test and restores the
 * original `chrome.storage` object afterwards.
 *
 * The two `HybridStorageArea` instances are created once (not re-created
 * per test) and only `.clear()`ed between tests: `webextension-polyfill`
 * wraps `chrome.storage.local` lazily on first access and memoises that
 * wrapped reference on its own module-singleton `browser` object for the
 * lifetime of the test file — reassigning `globalThis.chrome.storage.local`
 * to a *new* object instance on a later test does not un-memoise it, so a
 * later test would silently keep reading/writing the *first* test's
 * instance regardless. Clearing the same instance's contents in place
 * sidesteps that entirely, for both `.local` (wrapped) and `.session`
 * (unwrapped pass-through, not memoised the same way, but clearing it the
 * same way costs nothing and keeps both areas' reset semantics identical). */
export function useRealChromeStorage(): void {
  const local = new HybridStorageArea();
  const session = new HybridStorageArea();
  let original: unknown;
  let installed = false;

  beforeEach(() => {
    local.clear();
    session.clear();
    const g = globalThis as unknown as { chrome: { storage: unknown } };
    if (!installed) {
      original = g.chrome.storage;
      installed = true;
    }
    g.chrome.storage = {
      local,
      session,
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    };
  });

  afterEach(() => {
    const g = globalThis as unknown as { chrome: { storage: unknown } };
    g.chrome.storage = original;
  });
}
