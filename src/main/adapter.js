/*
 * adapter.js — the ONLY file that knows anything about EA's internals.
 *
 * Runs in the page's MAIN world so it can see the web app's own network calls.
 * It is strictly passive: it patches XMLHttpRequest and fetch to *read* the
 * responses the app was already going to receive, and sends a trimmed copy over
 * window.postMessage to the extension's isolated world. It never issues a
 * request, never touches the session token, and never changes a response.
 *
 * When EA reshuffles their bundle or changes the market payload, this file is
 * the one that breaks — and it is written to break LOUDLY. It reports every
 * market call it sees and every one it successfully parsed; the panel compares
 * the two and tells you when they diverge, so a patch day shows up as a red
 * banner rather than as silently empty data.
 */
(() => {
  'use strict';

  const CHANNEL = 'ledger:v1';

  // The UTAS market path has outlived many bundle rewrites: /ut/game/<title>/transfermarket
  const MARKET_PATH = /\/ut\/game\/[^/]+\/transfermarket\b/i;

  const stats = { seen: 0, parsed: 0, failed: 0 };

  function post(kind, data) {
    try {
      window.postMessage({ channel: CHANNEL, kind, data }, window.location.origin);
    } catch (_) {
      /* a page that has torn down its origin is not our problem */
    }
  }

  /*
   * Trim an auction down to the fields the model actually uses.
   *
   * This is deliberate, not just tidiness: nothing about the account, the club,
   * the session or the user leaves this function. If a field is not listed
   * here, the extension never sees it.
   */
  function trimAuction(a, seenAt) {
    const item = a.itemData || {};
    const expiresIn = Number(a.expires);
    return {
      tradeId: String(a.tradeId),
      resourceId: Number(item.resourceId ?? item.assetId ?? 0),
      assetId: Number(item.assetId ?? 0),
      rating: Number(item.rating ?? 0),
      buyNow: Number(a.buyNowPrice ?? 0),
      startingBid: Number(a.startingBid ?? 0),
      currentBid: Number(a.currentBid ?? 0),
      offers: Number(a.offers ?? 0),
      // expires arrives as seconds remaining; an absolute time is what we can compare later
      expiresAt: Number.isFinite(expiresIn) ? seenAt + expiresIn * 1000 : null,
      seenAt
    };
  }

  function handleBody(url, body) {
    if (typeof body !== 'string' || body.length === 0) {
      stats.failed++;
      post('shape', { ...stats, reason: 'empty body' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_) {
      stats.failed++;
      post('shape', { ...stats, reason: 'response was not JSON' });
      return;
    }

    if (!payload || !Array.isArray(payload.auctionInfo)) {
      // A market call with no auctionInfo is how a payload change first shows up.
      stats.failed++;
      post('shape', { ...stats, reason: 'no auctionInfo array in response' });
      return;
    }

    const seenAt = Date.now();
    const auctions = [];
    for (const a of payload.auctionInfo) {
      if (!a || a.tradeId == null) continue;
      const trimmed = trimAuction(a, seenAt);
      if (trimmed.resourceId > 0) auctions.push(trimmed);
    }

    stats.parsed++;
    post('auctions', { url: String(url).split('?')[0], seenAt, auctions, stats: { ...stats } });
  }

  function isMarket(url) {
    return typeof url === 'string' && MARKET_PATH.test(url);
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;

  proto.open = function (method, url, ...rest) {
    try {
      this.__ledgerUrl = typeof url === 'string' ? url : String(url);
    } catch (_) { /* ignore */ }
    return nativeOpen.call(this, method, url, ...rest);
  };

  proto.send = function (...args) {
    try {
      if (isMarket(this.__ledgerUrl)) {
        stats.seen++;
        this.addEventListener('load', () => {
          try {
            const type = this.responseType;
            if (type === '' || type === 'text') {
              handleBody(this.__ledgerUrl, this.responseText);
            } else if (type === 'json' && this.response) {
              handleBody(this.__ledgerUrl, JSON.stringify(this.response));
            } else {
              stats.failed++;
              post('shape', { ...stats, reason: 'unreadable responseType: ' + type });
            }
          } catch (_) {
            stats.failed++;
          }
        });
      }
    } catch (_) { /* never break the app's own request */ }
    return nativeSend.apply(this, args);
  };

  // ---- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (_) { /* ignore */ }

      const promise = nativeFetch.call(this, input, init);
      if (!isMarket(url)) return promise;

      stats.seen++;
      return promise.then((res) => {
        try {
          res.clone().text().then(
            (body) => handleBody(url, body),
            () => { stats.failed++; }
          );
        } catch (_) {
          stats.failed++;
        }
        return res;
      });
    };
  }

  post('ready', { channel: CHANNEL });
})();
