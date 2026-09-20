/*
 * content.js — the bridge.
 *
 * Runs in the isolated world. Listens for the trimmed auction data the adapter
 * posts out of the page, batches it, hands it to the service worker to store,
 * and drives the panel. It has no knowledge of EA's internals; if the market
 * payload changes, this file keeps working and adapter.js is the only thing to
 * fix.
 */

import { initAnalytics, trackEvent } from './analytics.js';

(() => {
  'use strict';

  const CHANNEL = 'ledger:v1';
  const FLUSH_MS = 2000;
  const FLUSH_AT = 300;

  // Initialize Vercel Analytics
  initAnalytics();

  const panel = globalThis.LedgerPanel();

  let queue = [];
  let flushTimer = null;
  let searches = 0;
  let lastResourceId = null;
  let lastRating = null;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          // A dead service worker or a reloaded extension shows up here.
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (_) {
        resolve(null);
      }
    });

  async function flush() {
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];

    const res = await send({ type: 'record', auctions: batch });
    if (!res || !res.ok) {
      panel.setHealth('warn', 'Recorded nothing — the extension background may have been reloaded.');
      return;
    }

    // Track auction recording event
    trackEvent('auctions_recorded', { count: batch.length });

    const totals = await send({ type: 'counts' });
    if (totals && totals.ok) panel.setTotals(totals.data);

    if (lastResourceId) {
      const summary = await send({ type: 'summary', resourceId: lastResourceId, minProfit: 1000 });
      if (summary && summary.ok) panel.setCard({ ...summary.data, rating: lastRating });
    }
  }

  function scheduleFlush() {
    if (queue.length >= FLUSH_AT) {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  /*
   * A search for one player returns that player's listings, so the modal
   * resourceId in a page of results is the card you were looking at. A broad
   * filter returns a mix and there is no single card to report — we take the
   * most common one and say nothing clever about the rest.
   */
  function dominantResource(auctions) {
    const tally = new Map();
    for (const a of auctions) tally.set(a.resourceId, (tally.get(a.resourceId) || 0) + 1);
    let best = null;
    let bestN = 0;
    for (const [id, n] of tally) {
      if (n > bestN) { best = id; bestN = n; }
    }
    // Below half the page it's a mixed filter, not a card.
    return bestN / auctions.length >= 0.5 ? best : null;
  }

  /*
   * The adapter posts 'ready' at document_start, which is well before this
   * script exists, so we never hear it. Set the opening state ourselves.
   */
  panel.setHealth('live', 'Recording. Nothing is sent anywhere.');
  send({ type: 'counts' }).then((r) => r && r.ok && panel.setTotals(r.data));

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.kind === 'shape') {
      // The adapter saw a market call it could not read. That is a patch day.
      panel.setHealth(
        'warn',
        'Not recording — the market response changed shape (' + msg.data.reason + '). adapter.js needs updating.'
      );
      return;
    }

    if (msg.kind === 'auctions') {
      const { auctions } = msg.data;
      searches++;
      panel.setSearches(searches);
      panel.setHealth('live', 'Recording. Nothing is sent anywhere.');

      // Track search event
      trackEvent('market_search', { auction_count: auctions.length });

      if (auctions.length > 0) {
        const dominant = dominantResource(auctions);
        if (dominant) {
          lastResourceId = dominant;
          const match = auctions.find((a) => a.resourceId === dominant);
          lastRating = match ? match.rating : null;
        }
        queue = queue.concat(auctions);
        scheduleFlush();
      }
    }
  });
})();
