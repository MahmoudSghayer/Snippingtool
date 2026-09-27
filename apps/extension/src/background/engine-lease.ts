/*
 * background/engine-lease.ts — the per-profile engine lease, and the live
 * engine state the heartbeat reports (P0 Task 13).
 *
 * Why a lease: every EA tab runs its own content script, and the engine —
 * the assist hotkeys, the autobuyer, the Sniping Bot, each with a governor
 * whose hourly windows live in that tab's memory — runs there (rule 5: the
 * service worker owns no loops). Two EA tabs therefore used to run two
 * engines, and each saved its own copy of the hourly windows over the
 * other's, so two tabs could spend twice the hourly budget. Rather than move
 * every `governor.allow()` behind an asynchronous round trip to this worker
 * (which would make the Sniping Bot's and the autobuyer's loops depend on a
 * worker MV3 may stop at any time), only one tab runs an engine: the one
 * holding this lease. A tab that gains it loads the budgets the previous
 * holder saved (`engine.stateGet`, `bot.budgetGet`) before it acts, and the
 * holder saves them after every action, so the budgets are one set per
 * profile however many tabs are open.
 *
 * The lease lives in `storage.session`: it survives this worker restarting
 * (a lease only in memory would be free again after every restart, while its
 * holder still runs), and is gone with the browser, like the tabs holding it.
 * The holder renews it every `ENGINE_LEASE_RENEW_MS`; one that stops (a
 * crashed tab) loses it after `ENGINE_LEASE_MS`, long enough that a hidden
 * tab whose timers Chrome throttles to once a minute keeps it. A closed tab
 * releases it on `pagehide`.
 *
 * The userscript has no service worker: every EA tab runs its own copy of
 * this file over one Tampermonkey store (userscript/browser-shim.ts maps
 * `storage.session` to it). With one tab — its normal case — the lease is
 * always free. With two, each acquire reads back what it wrote, which
 * catches all but a near-simultaneous pair of acquires from two tabs.
 */
import browser from 'webextension-polyfill';

import { EA_WEB_APP_MATCHES } from '../../ea-origins.mjs';
import { getSession, removeSession, setSession } from '../lib/storage.js';

import type { EngineState, ExtEngineLockPayload } from '@sl/shared';

const LEASE_KEY = 'sl.engine.lease.v1';
const ENGINE_STATE_KEY = 'sl.engine.liveState.v1';

/** How long a lease lasts without a renewal. */
export const ENGINE_LEASE_MS = 3 * 60_000;
/** How often the holder renews it (content/index.ts). */
export const ENGINE_LEASE_RENEW_MS = 20_000;

interface StoredLease {
  ownerId: string;
  expiresAt: number;
}

function readLease(value: unknown): StoredLease | null {
  const v = value as Partial<StoredLease> | null;
  if (!v || typeof v.ownerId !== 'string' || typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null;
  return { ownerId: v.ownerId, expiresAt: v.expiresAt };
}

// One lease operation at a time in this worker: an acquire's read and write
// must not interleave with another tab's.
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** `engine.lockAcquire`: takes (or renews) the lease for `ownerId` unless
 * another tab holds an unexpired one. */
export function handleEngineLockAcquire({ ownerId }: ExtEngineLockPayload): Promise<{ held: boolean; expiresAt: number }> {
  return serially(async () => {
    const now = Date.now();
    const current = readLease(await getSession<unknown>(LEASE_KEY, null));
    if (current && current.ownerId !== ownerId && current.expiresAt > now) return { held: false, expiresAt: current.expiresAt };
    const next: StoredLease = { ownerId, expiresAt: now + ENGINE_LEASE_MS };
    await setSession(LEASE_KEY, next);
    // Read back (see the header: two userscript tabs share the store).
    const stored = readLease(await getSession<unknown>(LEASE_KEY, null));
    if (stored?.ownerId !== ownerId) return { held: false, expiresAt: stored?.expiresAt ?? now };
    return { held: true, expiresAt: next.expiresAt };
  });
}

/** `engine.lockRelease`: frees the lease, if `ownerId` holds it. */
export function handleEngineLockRelease({ ownerId }: ExtEngineLockPayload): Promise<{ ok: true }> {
  return serially(async () => {
    const current = readLease(await getSession<unknown>(LEASE_KEY, null));
    if (current?.ownerId === ownerId) await removeSession(LEASE_KEY);
    return { ok: true as const };
  });
}

interface StoredEngineState {
  engineState: EngineState;
  at: number;
}

/** `engine.state`: what the lease holder's engine is doing, pushed with
 * every renewal. */
export async function handleEngineState(payload: { engineState: EngineState }): Promise<{ ok: true }> {
  await setSession(ENGINE_STATE_KEY, { engineState: payload.engineState, at: Date.now() } satisfies StoredEngineState);
  return { ok: true };
}

/** The engine state for the heartbeat: the last one pushed, or `idle` when
 * none was pushed for as long as a lease lasts (no EA tab runs an engine). */
export async function currentEngineState(): Promise<EngineState> {
  const stored = await getSession<StoredEngineState | null>(ENGINE_STATE_KEY, null);
  if (!stored || typeof stored.at !== 'number' || Date.now() - stored.at > ENGINE_LEASE_MS) return 'idle';
  return stored.engineState;
}

/** `engine.resetSession`, the popup's "New session": passed on to every open
 * EA tab, whose governor starts a new session (`Governor.resetSession`,
 * which never clears a cooldown, the hourly windows or the kill switch).
 * Only the tab holding the engine lease acts on it and saves the result;
 * the others load it when they gain the lease. */
export async function handleEngineResetSession(): Promise<{ notified: number }> {
  const message = { type: 'engine.resetSession' } as const;
  let tabs: Array<{ id?: number }>;
  try {
    tabs = await browser.tabs.query({ url: [...EA_WEB_APP_MATCHES] });
  } catch {
    return { notified: 0 };
  }
  let notified = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await browser.tabs.sendMessage(tab.id, message);
        notified++;
      } catch {
        // A tab with no content script yet: nothing running there to reset.
      }
    }),
  );
  return { notified };
}
