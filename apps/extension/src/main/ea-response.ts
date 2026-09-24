/*
 * ea-response.ts — turning whatever an EA service-layer call returned into
 * a response object, and a search response into its list of entries.
 * Shape-independent on purpose: both candidate shapes (main/shape-*.ts) go
 * through here, so "what if the call returns an observable, not a promise"
 * has one answer.
 *
 * The defect this exists for: the adapter used to `await` whatever the
 * search call returned. If EA's service returns an observable (as community
 * autobuyers describe — `.observe(scope, (sender, response) => ...)`), the
 * await resolves to the observable itself, the envelope lookup finds no
 * list, and the search was reported `ok` with no listings: a silent
 * success. Now an observable is observed, and a response with no list is an
 * error.
 */

const isArray = Array.isArray;
const objectKeys = Object.keys;
const apply = Reflect.apply;
const setTimer = setTimeout;
const clearTimer = clearTimeout;

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | null {
  return value !== null && typeof value === 'object' ? (value as Obj) : null;
}

function isObservable(value: unknown): value is { observe: (scope: unknown, cb: (sender: unknown, response: unknown) => void) => unknown } {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as Obj).observe === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as Obj).then === 'function';
}

/** Observe `observable` once: resolve with the first response its callback
 * gets, then `unobserve` if it can. Rejects if it never calls back within
 * `timeoutMs`, so an act call always gets an answer. */
function observeOnce(
  observable: { observe: (scope: unknown, cb: (sender: unknown, response: unknown) => void) => unknown },
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // The scope EA's observable calls back with as `this`; also the handle
    // `unobserve` takes. A fresh object, so it matches nothing of EA's.
    const scope = {};
    let done = false;
    const stop = (): void => {
      const unobserve = (observable as unknown as Obj).unobserve;
      if (typeof unobserve === 'function') {
        try {
          apply(unobserve, observable, [scope]);
        } catch {
          /* best effort */
        }
      }
    };
    const timer = setTimer(() => {
      if (done) return;
      done = true;
      stop();
      reject(new Error(`observable did not call back within ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      apply(observable.observe, observable, [
        scope,
        (_sender: unknown, response: unknown) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          stop();
          resolve(response);
        },
      ]);
    } catch (err) {
      done = true;
      clearTimer(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** The response a service-layer call produced: an observable is observed,
 * a promise awaited (and observed, if it resolves to an observable), any
 * other value passed through as-is for the caller to judge. */
export async function settle(value: unknown, timeoutMs: number): Promise<unknown> {
  if (isObservable(value)) return observeOnce(value, timeoutMs);
  if (isThenable(value)) {
    const resolved = await value;
    return isObservable(resolved) ? observeOnce(resolved, timeoutMs) : resolved;
  }
  return value;
}

/** Throws unless `response` is an object that does not report failure: a
 * `success` field, when present, must be exactly `true`. */
export function assertSucceeded(response: unknown, what: string): Obj {
  const r = asObject(response);
  if (!r) throw new Error(`${what} returned no response object (got ${response === null ? 'null' : typeof response})`);
  if ('success' in r && r.success !== true) {
    const status = typeof r.status === 'number' || typeof r.status === 'string' ? ` (status ${String(r.status)})` : '';
    throw new Error(`${what} reported success: ${String(r.success)}${status}`);
  }
  return r;
}

/** The list of entries in a search response, wherever the envelope keeps
 * it: `auctionInfo` (UTAS JSON), `items`, `data.items` (the observable
 * shape), `data.auctionInfo`. Throws — never returns `[]` — when there is
 * no list, so a changed envelope is an error, not "no results". */
export function extractListingArray(response: unknown): unknown[] {
  const r = assertSucceeded(response, 'search');
  const data = asObject(r.data);
  const candidates = [r.auctionInfo, r.items, data?.items, data?.auctionInfo];
  for (const candidate of candidates) if (isArray(candidate)) return candidate;
  const keys = objectKeys(r).slice(0, 12).join(', ');
  throw new Error(`search response has no auctionInfo / items / data.items list (keys: ${keys || 'none'})`);
}
