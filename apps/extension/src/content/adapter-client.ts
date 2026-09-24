/*
 * adapter-client.ts — the ISOLATED-world side of the `adapter.ts` act
 * surface. Sends `act_request` messages into the page's MAIN world and
 * resolves the matching `action_result` by `requestId`
 * (packages/shared/src/ext-messages.ts). This is the only way `content/`,
 * `engine/assist.ts` and `engine/autobuyer.ts` ever reach the page — none of
 * them touch `window.postMessage` directly.
 */
// Every page -> content message is validated against `@sl/shared`'s
// `adapterMessageSchema` before anything reads it: the channel is
// `window.postMessage`, so any script on EA's page can post on it too.
// (content.js already carries zod for the kill-switch message schema, so
// this costs no extra bundle weight.)
import { ADAPTER_CHANNEL, adapterMessageSchema } from '@sl/shared';

import { ACT_ERROR, canonicalActMessage, createActSigner } from '../lib/act-auth.js';

import type { AdapterDiagnostics, FilterCriteria, TrimmedAuction } from '@sl/shared';

const ACTION_TIMEOUT_MS = 15_000;

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  stillListed?: boolean;
  /** Only for `diagnostics()`. */
  diagnostics?: AdapterDiagnostics;
  latencyMs: number;
}

export interface ProbeStatus {
  ok: boolean;
  reason?: string;
  /** The EA service-layer shape the adapter selected (main/shapes.ts). */
  shape?: 'promise' | 'observable';
  checkedAt: number;
}

export interface AdapterClient {
  readonly probeStatus: ProbeStatus | null;
  search(filter: FilterCriteria): Promise<ActionOutcome>;
  buy(tradeId: string, price: number): Promise<ActionOutcome>;
  readResult(tradeId: string): Promise<ActionOutcome>;
  /** The adapter's read-only diagnostics report, over the same
   * authenticated channel as every act call (docs/06-extension.md §4). */
  diagnostics(): Promise<ActionOutcome>;
  onProbe(cb: (status: ProbeStatus) => void): () => void;
  onShape(cb: (reason: string) => void): () => void;
  onAuctions(cb: (auctions: TrimmedAuction[]) => void): () => void;
  dispose(): void;
}

type ActAction = 'search' | 'buy' | 'readResult' | 'diagnostics';

interface Pending {
  action: ActAction;
  resolve: (outcome: ActionOutcome) => void;
}

/**
 * @param nonce this page load's act-channel nonce (content/handoff.ts ->
 * `readHandedOffNonce`). Used only as the HMAC key for signing requests and
 * checking replies (lib/act-auth.ts); never posted. With `null`, every act
 * call fails closed with `adapter_unauthenticated` and nothing is sent.
 */
export function createAdapterClient(target: Window, nonce: string | null, options: { timeoutMs?: number } = {}): AdapterClient {
  const signer = createActSigner(nonce);
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  // Set by a probe saying `actReady: false`. Probes are unsigned, so any
  // page script can send one: the flag must never fail a call by itself. It
  // only changes how a call that times out anyway is reported —
  // `adapter_unauthenticated` (which the autobuyer does not retry) instead
  // of a retryable timeout. Worst case for a forged probe: one genuine
  // timeout is not retried. Cleared by any MAC-verified result, which only
  // an adapter holding the key can produce.
  let adapterReportedUnready = false;
  const pending = new Map<string, Pending>();
  const probeListeners = new Set<(status: ProbeStatus) => void>();
  const shapeListeners = new Set<(reason: string) => void>();
  const auctionsListeners = new Set<(auctions: TrimmedAuction[]) => void>();
  let probeStatus: ProbeStatus | null = null;

  function onMessage(event: MessageEvent): void {
    if (event.source !== target) return;
    // Drop anything that is not a well-formed adapter message. This also
    // drops this client's own `act_request`s, which arrive here too.
    const parsed = adapterMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (msg.kind === 'probe') {
      probeStatus = msg.data;
      if (msg.data.actReady === false) adapterReportedUnready = true;
      for (const cb of probeListeners) cb(msg.data);
      return;
    }
    if (msg.kind === 'shape') {
      for (const cb of shapeListeners) cb(msg.data.reason);
      return;
    }
    if (msg.kind === 'auctions') {
      for (const cb of auctionsListeners) cb(msg.data.auctions);
      return;
    }
    if (msg.kind === 'action_result') {
      // Only a reply to a request this client issued and is still waiting
      // on, for the same action, and signed by the adapter: a page script
      // that saw the request go by knows its requestId, but cannot sign a
      // fake `ok: true` for it. Unknown, duplicate or unsigned replies are
      // dropped; the real one (or the timeout) still settles the call.
      const data = msg.data;
      if (!data.requestId || !signer) return;
      const requestId = data.requestId;
      if (pending.get(requestId)?.action !== data.action) return;
      void signer.verify(canonicalActMessage('action_result', data), msg.mac).then((valid) => {
        const entry = pending.get(requestId);
        if (!valid) return;
        adapterReportedUnready = false;
        if (!entry || entry.action !== data.action) return;
        pending.delete(requestId);
        entry.resolve({
          ok: data.ok,
          error: data.error,
          stillListed: data.stillListed,
          diagnostics: data.diagnostics,
          latencyMs: data.completedAt - data.requestedAt,
        });
      });
    }
  }

  target.addEventListener('message', onMessage);

  function call(data: Record<string, unknown> & { action: ActAction }): Promise<ActionOutcome> {
    if (!signer) return Promise.resolve({ ok: false, error: ACT_ERROR.unauthenticated, latencyMs: 0 });
    const requestId = crypto.randomUUID();
    const request = { ...data, requestId };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return;
        resolve({
          ok: false,
          error: adapterReportedUnready ? ACT_ERROR.unauthenticated : 'timed out waiting for adapter response',
          latencyMs: timeoutMs,
        });
      }, timeoutMs);
      pending.set(requestId, {
        action: data.action,
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
      signer.sign(canonicalActMessage('act_request', request)).then(
        (mac) => target.postMessage({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: request, mac }, target.location.origin),
        () => {
          if (pending.delete(requestId)) {
            clearTimeout(timer);
            resolve({ ok: false, error: ACT_ERROR.unauthenticated, latencyMs: 0 });
          }
        },
      );
    });
  }

  return {
    get probeStatus() {
      return probeStatus;
    },
    search: (filter) => call({ action: 'search', filter }),
    // A listing with no buy-now price (0) can never match; the adapter would
    // drop the request anyway, so refuse here rather than time out.
    buy: (tradeId, price) =>
      price > 0 ? call({ action: 'buy', tradeId, price }) : Promise.resolve({ ok: false, error: ACT_ERROR.priceMismatch, latencyMs: 0 }),
    readResult: (tradeId) => call({ action: 'readResult', tradeId }),
    diagnostics: () => call({ action: 'diagnostics' }),
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
