/*
 * search-hook.ts — sees the item entities of searches the *human* runs, for
 * the observable shape (main/shape-observable.ts). UNVERIFIED like the rest
 * of that shape — docs/06-extension.md §4, day-one checklist.
 *
 * Why: that shape buys on the item entity a search returned, and passive
 * observation (the patched XHR/fetch in main/adapter.ts) only ever sees
 * JSON. Without this, every listing from the human's own searches in EA's
 * UI — most of what assist ranks — would be refused as
 * `listing_entity_unknown`.
 *
 * How: `services.Item.searchTransferMarket` is replaced by a wrapper that
 * calls the original with the same `this` and arguments and returns the
 * ORIGINAL observable, untouched. Before returning it, the wrapper adds one
 * observer of its own, which reads the first response and unobserves. The
 * page's own observers, callbacks and timing are not changed; the wrapper
 * never throws on the page's behalf (anything it does is in try/catch), and
 * never constructs or sends anything. The adapter's own act searches go
 * through `unhooked`, so they are not reported twice.
 *
 * Zod-free and chrome-free, like the rest of `src/main/`.
 */
import { isObservable } from './ea-response.js';

const apply = Reflect.apply;
const weakSetHas = WeakSet.prototype.has;
const weakSetAdd = WeakSet.prototype.add;

type Obj = Record<string, unknown>;

export interface SearchHook {
  /** Install on `services.Item.searchTransferMarket` if it is there and not
   * already ours. Idempotent; re-installs if the page replaced the
   * function or the `Item` object. Returns whether the hook is in place. */
  ensure(services: unknown): boolean;
  /** Whether the hook is in place on `services` right now. */
  isInstalled(services: unknown): boolean;
  /** Run `fn` with the hook standing aside for any search call `fn` makes
   * synchronously (the service call itself is synchronous; only its answer
   * is not). */
  unhooked<T>(fn: () => T): T;
}

export function createSearchHook(onResponse: (response: unknown) => void): SearchHook {
  const wrappers = new WeakSet<object>();
  let suppressed = 0;

  function item(services: unknown): Obj | null {
    const i = services && typeof services === 'object' ? (services as Obj).Item : null;
    return i && typeof i === 'object' ? (i as Obj) : null;
  }

  function watch(returned: unknown): void {
    if (!isObservable(returned)) return;
    const scope = {};
    let seen = false;
    try {
      apply(returned.observe, returned, [
        scope,
        (_sender: unknown, response: unknown) => {
          if (seen) return;
          seen = true;
          const unobserve = (returned as unknown as Obj).unobserve;
          if (typeof unobserve === 'function') {
            try {
              apply(unobserve, returned, [scope]);
            } catch {
              /* best effort */
            }
          }
          try {
            onResponse(response);
          } catch {
            /* never let the adapter's handling reach EA's code */
          }
        },
      ]);
    } catch {
      /* an observable that will not take a second observer: nothing seen */
    }
  }

  return {
    ensure(services) {
      const target = item(services);
      const current = target?.searchTransferMarket;
      if (!target || typeof current !== 'function') return false;
      if (apply(weakSetHas, wrappers, [current])) return true;
      const original = current as (...args: unknown[]) => unknown;
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const returned = apply(original, this, args);
        if (suppressed === 0) watch(returned);
        return returned;
      };
      try {
        target.searchTransferMarket = wrapper;
      } catch {
        return false; // non-writable: leave the page's function alone
      }
      if (target.searchTransferMarket !== wrapper) return false;
      apply(weakSetAdd, wrappers, [wrapper]);
      return true;
    },
    isInstalled(services) {
      const current = item(services)?.searchTransferMarket;
      return typeof current === 'function' && apply(weakSetHas, wrappers, [current]) === true;
    },
    unhooked(fn) {
      suppressed++;
      try {
        return fn();
      } finally {
        suppressed--;
      }
    },
  };
}
