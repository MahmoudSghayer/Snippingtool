/*
 * background-timer.ts — waits that keep their pace while the EA tab is in
 * the background.
 *
 * Chrome throttles timers on a hidden page's main thread: to once a second
 * straight away, and after five minutes hidden to about once a minute
 * ("intensive throttling"). Nova AI waits on a timer between searches, so
 * minimised or behind another tab it slowed almost to a stop. Timers in a
 * dedicated worker are not throttled like that, and the message the worker
 * posts back is handled as soon as it arrives, so the waits are timed in
 * one. If the page will not run the worker (its Content Security Policy
 * can forbid blob: workers), every wait falls back to the page's own
 * setTimeout, as before.
 */

const WORKER_SOURCE =
  'const t=new Map();onmessage=(e)=>{const[k,id,ms]=e.data;' +
  "if(k==='set')t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms));" +
  'else{clearTimeout(t.get(id));t.delete(id)}}';

type WorkerLike = Pick<Worker, 'postMessage' | 'addEventListener'>;

interface Pending {
  due: number;
  fire: () => void;
  fallback?: ReturnType<typeof setTimeout>;
}

/** A sleep with the Sniper's `deps.sleep` signature: resolves after `ms`,
 * or at once when `signal` aborts. `makeWorker` is for tests. */
export function createBackgroundSleep(
  makeWorker: () => WorkerLike | null = defaultWorker,
): (ms: number, signal: AbortSignal) => Promise<void> {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let worker: WorkerLike | null = null;
  try {
    worker = makeWorker();
  } catch {
    worker = null;
  }

  function useFallback(id: number, p: Pending): void {
    p.fallback = setTimeout(() => {
      pending.delete(id);
      p.fire();
    }, Math.max(0, p.due - Date.now()));
  }

  if (worker) {
    worker.addEventListener('message', (e: MessageEvent) => {
      const p = pending.get(e.data as number);
      if (!p) return;
      pending.delete(e.data as number);
      p.fire();
    });
    // A worker the page's policy blocks reports it here rather than
    // throwing: re-time whatever was waiting on it, and stop using it.
    worker.addEventListener('error', () => {
      worker = null;
      for (const [id, p] of pending) useFallback(id, p);
    });
  }

  return (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const id = nextId++;
      const p: Pending = { due: Date.now() + ms, fire: done };
      function done(): void {
        signal.removeEventListener('abort', cancel);
        resolve();
      }
      function cancel(): void {
        if (!pending.delete(id)) return;
        if (p.fallback !== undefined) clearTimeout(p.fallback);
        else worker?.postMessage(['clear', id]);
        done();
      }
      pending.set(id, p);
      signal.addEventListener('abort', cancel);
      if (worker) worker.postMessage(['set', id, ms]);
      else useFallback(id, p);
    });
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker !== 'function' || typeof Blob !== 'function') return null;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  return new Worker(url);
}
