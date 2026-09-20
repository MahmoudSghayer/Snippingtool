/*
 * adapter-client.ts — the ISOLATED-world side of the `adapter.ts` act
 * surface. Sends `act_request` messages into the page's MAIN world and
 * resolves the matching `action_result` by `requestId`
 * (packages/shared/src/ext-messages.ts). This is the only way `content/`,
 * `engine/assist.ts` and `engine/autobuyer.ts` ever reach the page — none of
 * them touch `window.postMessage` directly.
 */
import { ADAPTER_CHANNEL, type FilterCriteria } from '@sl/shared';

const ACTION_TIMEOUT_MS = 15_000;

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  stillListed?: boolean;
  latencyMs: number;
}

export interface ProbeStatus {
  ok: boolean;
  reason?: string;
  checkedAt: number;
}

export interface AdapterClient {
  readonly probeStatus: ProbeStatus | null;
  search(filter: FilterCriteria): Promise<ActionOutcome>;
  buy(tradeId: string, price: number): Promise<ActionOutcome>;
  readResult(tradeId: string): Promise<ActionOutcome>;
  onProbe(cb: (status: ProbeStatus) => void): () => void;
  onShape(cb: (reason: string) => void): () => void;
  onAuctions(cb: (auctions: unknown[]) => void): () => void;
  dispose(): void;
}

export function createAdapterClient(target: Window = window): AdapterClient {
  const pending = new Map<string, (outcome: ActionOutcome) => void>();
  const probeListeners = new Set<(status: ProbeStatus) => void>();
  const shapeListeners = new Set<(reason: string) => void>();
  const auctionsListeners = new Set<(auctions: unknown[]) => void>();
  let probeStatus: ProbeStatus | null = null;

  function onMessage(event: MessageEvent): void {
    if (event.source !== target) return;
    const msg = event.data as { channel?: string; kind?: string; data?: unknown } | null;
    if (!msg || msg.channel !== ADAPTER_CHANNEL) return;

    if (msg.kind === 'probe') {
      probeStatus = msg.data as ProbeStatus;
      for (const cb of probeListeners) cb(probeStatus);
      return;
    }
    if (msg.kind === 'shape') {
      const data = msg.data as { reason: string };
      for (const cb of shapeListeners) cb(data.reason);
      return;
    }
    if (msg.kind === 'auctions') {
      const data = msg.data as { auctions: unknown[] };
      for (const cb of auctionsListeners) cb(data.auctions);
      return;
    }
    if (msg.kind === 'action_result') {
      const data = msg.data as {
        requestId?: string;
        ok: boolean;
        error?: string;
        stillListed?: boolean;
        requestedAt: number;
        completedAt: number;
      };
      if (!data.requestId) return;
      const resolve = pending.get(data.requestId);
      if (!resolve) return;
      pending.delete(data.requestId);
      resolve({ ok: data.ok, error: data.error, stillListed: data.stillListed, latencyMs: data.completedAt - data.requestedAt });
    }
  }

  target.addEventListener('message', onMessage);

  function call(data: Record<string, unknown> & { action: string }): Promise<ActionOutcome> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) resolve({ ok: false, error: 'timed out waiting for adapter response', latencyMs: ACTION_TIMEOUT_MS });
      }, ACTION_TIMEOUT_MS);
      pending.set(requestId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      target.postMessage({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { ...data, requestId } }, target.location.origin);
    });
  }

  return {
    get probeStatus() {
      return probeStatus;
    },
    search: (filter) => call({ action: 'search', filter }),
    buy: (tradeId, price) => call({ action: 'buy', tradeId, price }),
    readResult: (tradeId) => call({ action: 'readResult', tradeId }),
    onProbe: (cb) => {
      probeListeners.add(cb);
      return () => probeListeners.delete(cb);
    },
    onShape: (cb) => {
      shapeListeners.add(cb);
      return () => shapeListeners.delete(cb);
    },
    onAuctions: (cb) => {
      auctionsListeners.add(cb);
      return () => auctionsListeners.delete(cb);
    },
    dispose: () => {
      target.removeEventListener('message', onMessage);
      pending.clear();
      probeListeners.clear();
      shapeListeners.clear();
      auctionsListeners.clear();
    },
  };
}
