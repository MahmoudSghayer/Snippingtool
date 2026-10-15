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
 * can forbid blob: workers), or the worker ever fails to answer, waits fall
 * back to the page's own setTimeout: slower in the background, but never
 * stuck. `mode()` says which is in use, for the bot's log.
 */

const WORKER_SOURCE =
  'const t=new Map();onmessage=(e)=>{const[k,id,ms]=e.data;' +
  "if(k==='set')t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms));" +
  'else{clearTimeout(t.get(id));t.delete(id)}}';

/** How much later than the worker the page's own backup timer fires a
 * wait the worker never answered. */
const WORKER_GRACE_MS = 5_000;

type WorkerLike = Pick<Worker, 'postMessage' | 'addEventListener'>;

interface Pending {
  due: number;
  fire: () => void;
  /** The page timer: the backup while the worker is in use, the only
   * timer once it is not. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface BackgroundTimer {
  /** The Sniper's `deps.sleep`: resolves after `ms`, or at once when
   * `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** `worker` while waits keep their pace in the background, `page` once
   * they have fallen back to the page's (throttled) timers. */
  mode(): 'worker' | 'page';
}

/** `makeWorker` is for tests. */
export function createBackgroundTimer(makeWorker: () => WorkerLike | null = defaultWorker): BackgroundTimer {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let worker: WorkerLike | null = null;
  try {
    worker = makeWorker();
  } catch {
    worker = null;
  }

  function settle(id: number): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.fire();
  }

  function onPageTimers(id: number, p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = setTimeout(() => settle(id), Math.max(0, p.due - Date.now()));
  }

  /** Stop using the worker: re-time everything still waiting on it. */
  function dropWorker(): void {
    worker = null;
    for (const [id, p] of pending) onPageTimers(id, p);
  }

  if (worker) {
    worker.addEventListener('message', (e: MessageEvent) => settle(e.data as number));
    // A worker the page's policy blocks can report it here rather than
    // throwing.
    worker.addEventListener('error', dropWorker);
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const id = nextId++;
      const p: Pending = { due: Date.now() + ms, fire: done };
      function done(): void {
        signal.removeEventListener('abort', cancel);
        resolve();
      }
      function cancel(): void {
        if (!pending.has(id)) return;
        worker?.postMessage(['clear', id]);
        settle(id);
      }
      pending.set(id, p);
      signal.addEventListener('abort', cancel);
      if (worker) {
        worker.postMessage(['set', id, ms]);
        // Should the worker never answer, the page's timer still ends the
        // wait (late), and the worker is not trusted again.
        p.timer = setTimeout(() => {
          if (!pending.has(id)) return;
          dropWorker();
          settle(id);
        }, ms + WORKER_GRACE_MS);
      } else {
        onPageTimers(id, p);
      }
    });
  }

  return { sleep, mode: () => (worker ? 'worker' : 'page') };
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker !== 'function' || typeof Blob !== 'function') return null;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  return new Worker(url);
}
