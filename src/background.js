/*
 * background.js — the service worker.
 *
 * MV3 kills this worker after roughly 30 seconds idle, so it deliberately owns
 * no loops and no timers. It wakes on a message, writes, answers, and dies.
 * Every long-lived thing lives in the page. Several competing extensions put
 * their sniping loop in here and quietly stop working after half a minute.
 *
 * It owns the database because the extension's own origin survives a clear of
 * ea.com's site data.
 */

import * as db from './store/db.js';
import { summarise, margin, maxSnipePrice } from './model/prices.js';
import { initAnalytics } from './analytics.js';

// Initialize Vercel Analytics when the service worker starts
initAnalytics();

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a week of history per card

const handlers = {
  async record({ auctions }) {
    const result = await db.recordSightings(auctions);
    return result;
  },

  async summary({ resourceId, minProfit }) {
    const rows = await db.auctionsForResource(resourceId, WINDOW_MS);
    const s = summarise(rows);
    return {
      resourceId,
      summary: s,
      margin: s.floor == null ? null : margin(s, s.floor),
      maxSnipe: maxSnipePrice(s, minProfit || 1000)
    };
  },

  async counts() {
    return db.counts();
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const known = msg && typeof msg.type === 'string'
    && Object.prototype.hasOwnProperty.call(handlers, msg.type);
  if (!known) return false;
  const handler = handlers[msg.type];

  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));

  return true; // keep the channel open for the async reply
});
