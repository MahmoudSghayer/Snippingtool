/*
 * background/lifecycle.ts — runs the trade lifecycle (lib/trade-lifecycle.ts)
 * for every EA tab at once, over IndexedDB (store/lifecycle-db.ts). In
 * background, not content: two tabs showing the same trade pile then share
 * one record per item, so a sale is still reported once.
 *
 * A sale goes into the same telemetry queue as the buy (`trades` ->
 * `/trades/batch`), which already persists, retries and re-sends it.
 */
import { getSession, setSession } from '../lib/storage.js';
import { TradeLifecycle } from '../lib/trade-lifecycle.js';
import { idbLifecycleStore } from '../store/lifecycle-db.js';

import { handleTelemetryEnqueue } from './telemetry.js';

import type { LifecycleBuy, LifecycleSessionPnl, TradePileItem } from '@sl/shared';

const SESSION_START_KEY = 'sl.lifecycle.sessionStart.v1';

const lifecycle = new TradeLifecycle({
  store: idbLifecycleStore,
  reportSale: async (trade) => {
    await handleTelemetryEnqueue({ kind: 'trades', items: [trade] });
  },
});

let resumed: Promise<unknown> | null = null;
/** Once per service-worker start: re-send any sale a previous run
 * persisted but did not hand over. */
function resumeOnce(): Promise<unknown> {
  resumed ??= lifecycle.resumeUnreported().catch(() => 0);
  return resumed;
}

/** The browser session's start (`storage.session` outlives a service
 * worker restart but not the browser): "this session" for P&L. */
async function sessionStart(): Promise<number> {
  const stored = await getSession<number | null>(SESSION_START_KEY, null);
  if (typeof stored === 'number') return stored;
  const now = Date.now();
  await setSession(SESSION_START_KEY, now);
  return now;
}

export async function handleLifecycleBuy(payload: LifecycleBuy): Promise<{ ok: true }> {
  await resumeOnce();
  await lifecycle.recordBuy(payload);
  return { ok: true };
}

export async function handleLifecyclePile(payload: { items: TradePileItem[] }): Promise<{ reported: number }> {
  await resumeOnce();
  return { reported: await lifecycle.observePile(payload.items) };
}

export async function handleLifecycleSessionPnl(): Promise<LifecycleSessionPnl> {
  await resumeOnce();
  return lifecycle.sessionPnl(await sessionStart());
}
