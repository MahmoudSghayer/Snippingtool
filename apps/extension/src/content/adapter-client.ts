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

import type { Catalog } from '../model/catalog.js';
import type { AdapterDiagnostics, FilterCriteria, TradePileItem, TrimmedAuction } from '@sl/shared';

const ACTION_TIMEOUT_MS = 15_000;
/** How long a `timeout_unknown` buy waits for EA's late answer before it is
 * given up as not bought. */
const LATE_RESULT_WAIT_MS = 5 * 60_000;
/** How long a verified late result that overtook its own `timeout_unknown`
 * (both are verified asynchronously) is held for it. */
const EARLY_LATE_HOLD_MS = 30_000;

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  stillListed?: boolean;
  /** Only for `diagnostics()`. */
  diagnostics?: AdapterDiagnostics;
  /** Only for a buy that came back `timeout_unknown`: settles with EA's
   * late answer if the adapter sends one (signed, like every result), or
   * `ok: false` after a few minutes without one. */
  late?: Promise<ActionOutcome>;
  /** Set only on an outcome taken from an adapter result whose MAC
   * verified. Anything else — this client's own timeout, even one reported
   * as `adapter_unauthenticated` because an unsigned probe hinted so — is
   * unsigned, and a page script may have shaped it. Only a signed refusal
   * may give budget back to the governor (lib/act-auth.ts's
   * `isAdapterRefusal`). */
  signed?: true;
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
  /** `card`, when given, binds the buy to that card: the adapter refuses
   * (`resource_mismatch`) unless the listing it saw for `tradeId` has the
   * same resourceId (and assetId, when given). */
  buy(tradeId: string, price: number, card?: { resourceId: number; assetId?: number }): Promise<ActionOutcome>;
  readResult(tradeId: string): Promise<ActionOutcome>;
  /** The adapter's read-only diagnostics report, over the same
   * authenticated channel as every act call (docs/06-extension.md §4). */
  diagnostics(): Promise<ActionOutcome>;
  onProbe(cb: (status: ProbeStatus) => void): () => void;
  onShape(cb: (reason: string) => void): () => void;
  onAuctions(cb: (auctions: TrimmedAuction[]) => void): () => void;
  /** Already-reported listings the adapter can now buy. Not a search. */
  onBuyable(cb: (tradeIds: string[]) => void): () => void;
  /** The Snipe Targets form's choices, built with the web app's own lists
   * (model/catalog.ts). Only a catalog whose MAC verifies under this page
   * load's nonce, and that passed the schema, reaches `cb`. */
  onCatalog(cb: (catalog: Catalog) => void): () => void;
  /** Asks the adapter for them, over the authenticated act channel (it
   * sends them once the web app is ready). Nothing is sent without a key. */
  requestCatalog(): void;
  /** The trader's own trade-pile items the adapter read. Not a search. */
  /** `full`: a plain GET of the whole trade pile (see the message schema). */
  onTradePile(cb: (items: TradePileItem[], full: boolean) => void): () => void;
  dispose(): void;
}

/**
 * The page's own window. In the extension's ISOLATED world `window` already
 * is it. In the userscript, Tampermonkey hands the script a sandboxed
 * `window` stand-in, and messages the page posts come from the real window
 * (`unsafeWindow`): comparing them against the stand-in would drop every
 * one. The real window is what this client listens and posts on.
 */
export function pageWindow(): Window {
  // Tampermonkey provides `unsafeWindow` as a variable in the script's
  // scope, not as a property of its global object: it has to be named.
  return typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
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
  // `timeout_unknown` buys still waiting for EA's late answer.
  const lateWaiting = new Map<string, (outcome: ActionOutcome) => void>();
  // Verified late results that arrived before their `timeout_unknown`.
  const earlyLate = new Map<string, ActionOutcome>();
  const buyableListeners = new Set<(tradeIds: string[]) => void>();
  const probeListeners = new Set<(status: ProbeStatus) => void>();
  const shapeListeners = new Set<(reason: string) => void>();
  const auctionsListeners = new Set<(auctions: TrimmedAuction[]) => void>();
  const catalogListeners = new Set<(catalog: Catalog) => void>();
  const pileListeners = new Set<(items: TradePileItem[], full: boolean) => void>();
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
    if (msg.kind === 'tradepile') {
      for (const cb of pileListeners) cb(msg.data.items, msg.data.full === true);
      return;
    }
    if (msg.kind === 'listings_buyable') {
      for (const cb of buyableListeners) cb(msg.data.tradeIds);
      return;
    }
    if (msg.kind === 'catalog') {
      // Signed, like an action result: it fills the Sniping Bot's target
      // form, so a page script must not be able to choose its entries.
      if (!signer || catalogListeners.size === 0) return;
      const data = msg.data;
      void signer.verify(canonicalActMessage('catalog', data), msg.mac).then((valid) => {
        if (!valid) return;
        adapterReportedUnready = false;
        for (const cb of catalogListeners) cb(data.catalog);
      });
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
      if (data.late === true) {
        // Only for a buy this client issued (still pending, or waiting for
        // its late answer), and only signed.
        if (data.action !== 'buy' || !(lateWaiting.has(requestId) || pending.get(requestId)?.action === 'buy')) return;
        void signer.verify(canonicalActMessage('action_result', data), msg.mac).then((valid) => {
          if (!valid) return;
          const late: ActionOutcome = { ok: data.ok, error: data.error, signed: true, latencyMs: data.completedAt - data.requestedAt };
          const settleLate = lateWaiting.get(requestId);
          if (settleLate) {
            lateWaiting.delete(requestId);
            settleLate(late);
            return;
          }
          // It overtook its own `timeout_unknown`: hold it for that.
          earlyLate.set(requestId, late);
          setTimeout(() => earlyLate.delete(requestId), EARLY_LATE_HOLD_MS);
        });
        return;
      }
      if (pending.get(requestId)?.action !== data.action) return;
      void signer.verify(canonicalActMessage('action_result', data), msg.mac).then((valid) => {
        const entry = pending.get(requestId);
        if (!valid) return;
        adapterReportedUnready = false;
        if (!entry || entry.action !== data.action) return;
        pending.delete(requestId);
        const outcome: ActionOutcome = {
          ok: data.ok,
          error: data.error,
          stillListed: data.stillListed,
          diagnostics: data.diagnostics,
          signed: true,
          latencyMs: data.completedAt - data.requestedAt,
        };
        if (data.action === 'buy' && !data.ok && data.error === ACT_ERROR.timeoutUnknown) outcome.late = waitForLate(requestId);
        entry.resolve(outcome);
      });
    }
  }

  function waitForLate(requestId: string): Promise<ActionOutcome> {
    const early = earlyLate.get(requestId);
    if (early) {
      earlyLate.delete(requestId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (lateWaiting.delete(requestId)) resolve({ ok: false, error: 'no_late_answer', latencyMs: LATE_RESULT_WAIT_MS });
      }, LATE_RESULT_WAIT_MS);
      lateWaiting.set(requestId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  target.addEventListener('message', onMessage);

  /** A request with no result to wait for: the adapter answers a catalog
   * request with a (signed) `catalog` message, if it has one. */
  function notify(data: Record<string, unknown> & { action: 'catalog' }): void {
    if (!signer) return;
    const request = { ...data, requestId: crypto.randomUUID() };
    signer.sign(canonicalActMessage('act_request', request)).then(
      (mac) => target.postMessage({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: request, mac }, target.location.origin),
      () => undefined,
    );
  }

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
    buy: (tradeId, price, card) =>
      price > 0
        ? call({
            action: 'buy',
            tradeId,
            price,
            // Only real ids: EA listings can lack one (ea-listing.ts reads it
            // as 0), and the adapter drops a request with a non-positive id
            // unanswered, which would surface as a timeout, not a refusal.
            ...(card && card.resourceId > 0 ? { resourceId: card.resourceId } : {}),
            ...(card?.assetId !== undefined && card.assetId > 0 ? { assetId: card.assetId } : {}),
          })
        : Promise.resolve({ ok: false, error: ACT_ERROR.priceMismatch, latencyMs: 0 }),
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
    onBuyable: (cb) => {
      buyableListeners.add(cb);
      return () => buyableListeners.delete(cb);
    },
    onCatalog: (cb) => {
      catalogListeners.add(cb);
      return () => catalogListeners.delete(cb);
    },
    requestCatalog: () => notify({ action: 'catalog' }),
    onTradePile: (cb) => {
      pileListeners.add(cb);
      return () => pileListeners.delete(cb);
    },
    dispose: () => {
      target.removeEventListener('message', onMessage);
      pending.clear();
      lateWaiting.clear();
      earlyLate.clear();
      buyableListeners.clear();
      probeListeners.clear();
      shapeListeners.clear();
      auctionsListeners.clear();
      catalogListeners.clear();
      pileListeners.clear();
    },
  };
}
