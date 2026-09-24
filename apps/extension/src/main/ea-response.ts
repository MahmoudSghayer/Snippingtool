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
const now = Date.now;
const promiseThen = Promise.prototype.then;
const promiseResolve = Promise.resolve.bind(Promise);

type Obj = Record<string, unknown>;

/** An error the adapter's own code raised, with a message it wrote itself
 * — safe to log. Anything else thrown during a call came from EA's code
 * and is logged only through `describeError`. */
export class ShapeError extends Error {
  override name = 'ShapeError';
}

/** An observable (or promise) that did not answer within the limit. For a
 * buy this means "outcome unknown": EA may still have gone through with it
 * (`settle`'s `onLate` reports it if it does). */
export class TimeoutUnknownError extends ShapeError {
  override name = 'TimeoutUnknownError';
}

const SHORT_TOKEN = /^[\w.-]{1,40}$/;

/** A loggable description of anything a call threw or rejected with. Our
 * own `ShapeError`s keep their message; for anything from EA's code only an
 * allowlist goes in — the error's class, and `success`/`status`/`code` when
 * they are short scalars — never its message text, which could quote a
 * coin balance or an account detail. */
export function describeError(err: unknown): string {
  if (err instanceof ShapeError) return err.message;
  const parts: string[] = [];
  if (err instanceof Error) parts.push(`EA threw ${SHORT_TOKEN.test(err.name) ? err.name : 'Error'}`);
  else parts.push(`EA rejected with ${err === null ? 'null' : typeof err}`);
  if (err !== null && typeof err === 'object') {
    for (const key of ['success', 'status', 'code'] as const) {
      const v = (err as Obj)[key];
      if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && SHORT_TOKEN.test(v))) parts.push(`${key}: ${String(v)}`);
    }
  }
  return parts.join(', ');
}

function asObject(value: unknown): Obj | null {
  return value !== null && typeof value === 'object' ? (value as Obj) : null;
}

type ObservableLike = { observe: (scope: unknown, cb: (sender: unknown, response: unknown) => void) => unknown };

export function isObservable(value: unknown): value is ObservableLike {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as Obj).observe === 'function';
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as Obj).then === 'function';
}

/** Stop observing: `unobserve(scope)` if the observable has one. */
function unobserve(observable: ObservableLike, scope: object): void {
  const fn = (observable as unknown as Obj).unobserve;
  if (typeof fn !== 'function') return;
  try {
    apply(fn, observable, [scope]);
  } catch {
    /* best effort */
  }
}

/** Observe `observable` once: resolve with the first response its callback
 * gets, then `unobserve` if it can. Rejects with `TimeoutUnknownError` if
 * it has not called back within `timeoutMs`, so an act call always gets an
 * answer. With `onLate`, it keeps listening after that and hands a late
 * response to `onLate` instead. */
function observeOnce(observable: ObservableLike, timeoutMs: number, onLate?: (response: unknown) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // The scope EA's observable calls back with as `this`; also the handle
    // `unobserve` takes. A fresh object, so it matches nothing of EA's.
    const scope = {};
    let timedOut = false;
    let finished = false;
    const timer = setTimer(
      () => {
        if (finished) return;
        timedOut = true;
        if (!onLate) {
          finished = true;
          unobserve(observable, scope);
        }
        reject(new TimeoutUnknownError(`observable did not call back within ${timeoutMs} ms`));
      },
      Math.max(0, timeoutMs),
    );
    try {
      apply(observable.observe, observable, [
        scope,
        (_sender: unknown, response: unknown) => {
          if (finished) return;
          finished = true;
          unobserve(observable, scope);
          if (!timedOut) {
            clearTimer(timer);
            resolve(response);
          } else {
            onLate?.(response);
          }
        },
      ]);
    } catch (err) {
      finished = true;
      clearTimer(timer);
      reject(err);
    }
  });
}

/** `promise`, rejected with `TimeoutUnknownError` if it has not settled by
 * `deadline`; a value it resolves with after that goes to `onLate`.
 * Observed through the captured `then`, like the rest of the adapter's
 * MAIN-world code. */
function withDeadline(promise: PromiseLike<unknown>, deadline: number, onLate?: (response: unknown) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimer(
      () => {
        timedOut = true;
        reject(new TimeoutUnknownError('promise did not settle in time'));
      },
      Math.max(0, deadline - now()),
    );
    apply(promiseThen, promiseResolve(promise), [
      (value: unknown) => {
        clearTimer(timer);
        if (timedOut) onLate?.(value);
        else resolve(value);
      },
      (err: unknown) => {
        clearTimer(timer);
        reject(err);
      },
    ]);
  });
}

/** The response a service-layer call produced: an observable is observed,
 * a promise awaited (and observed, if it resolves to an observable), any
 * other value passed through as-is for the caller to judge. All within one
 * `timeoutMs` deadline. `onLate` receives a response that arrives after
 * the deadline (a late rejection stays unreported: still unknown). */
export async function settle(value: unknown, timeoutMs: number, onLate?: (response: unknown) => void): Promise<unknown> {
  const deadline = now() + timeoutMs;
  if (isObservable(value)) return observeOnce(value, timeoutMs, onLate);
  if (isThenable(value)) {
    const resolved = await withDeadline(value, deadline, onLate);
    return isObservable(resolved) ? observeOnce(resolved, deadline - now(), onLate) : resolved;
  }
  return value;
}

/** Throws unless `response` is an object that does not report failure: a
 * `success` field, when present, must be exactly `true` — and with
 * `requireSuccess`, it must be present too. */
export function assertSucceeded(response: unknown, what: string, requireSuccess = false): Obj {
  const r = asObject(response);
  if (!r) throw new ShapeError(`${what} returned no response object (got ${response === null ? 'null' : typeof response})`);
  if (('success' in r || requireSuccess) && r.success !== true) {
    const status = typeof r.status === 'number' || (typeof r.status === 'string' && SHORT_TOKEN.test(r.status)) ? ` (status ${String(r.status)})` : '';
    const success = 'success' in r ? (typeof r.success === 'boolean' ? String(r.success) : typeof r.success) : 'missing';
    throw new ShapeError(`${what} reported success: ${success}${status}`);
  }
  return r;
}

/** The list of entries in a search response, wherever the envelope keeps
 * it: `auctionInfo` (UTAS JSON), `items`, `data.items` (the observable
 * shape), `data.auctionInfo`. Throws — never returns `[]` — when there is
 * no list, so a changed envelope is an error, not "no results". */
export function extractListingArray(response: unknown, options: { requireSuccess?: boolean } = {}): unknown[] {
  const r = assertSucceeded(response, 'search', options.requireSuccess);
  const data = asObject(r.data);
  const candidates = [r.auctionInfo, r.items, data?.items, data?.auctionInfo];
  for (const candidate of candidates) if (isArray(candidate)) return candidate;
  const keys = objectKeys(r).slice(0, 12).join(', ');
  throw new ShapeError(`search response has no auctionInfo / items / data.items list (keys: ${keys || 'none'})`);
}
