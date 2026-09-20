/*
 * db.js — the observation store.
 *
 * Every listing the web app shows you gets written here, in the extension's own
 * origin (not ea.com's, so clearing the site's data doesn't wipe your history).
 * Nothing in here is ever uploaded anywhere.
 *
 * One row per auction, not per sighting. Keeping firstSeen/lastSeen on a single
 * row is what lets us tell later whether a card sold or just expired, which is
 * the number FUTBIN structurally cannot give you.
 */

const DB_NAME = 'ledger';
const DB_VERSION = 1;

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('auctions')) {
        const s = db.createObjectStore('auctions', { keyPath: 'tradeId' });
        s.createIndex('by_resource', 'resourceId', { unique: false });
        s.createIndex('by_lastSeen', 'lastSeen', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Record a batch of sightings.
 *
 * Split deliberately into one read transaction then one write transaction, with
 * every request queued synchronously inside each. An IndexedDB transaction goes
 * inactive the moment the microtask queue drains, so awaiting in the middle of
 * one is the classic way to get TransactionInactiveError under load — and under
 * load is exactly where this runs.
 *
 * An auction we have seen before gets its lastSeen and sighting count bumped; a
 * new one gets inserted. Sellers cannot edit a live listing, so buyNow is
 * written once and never revised.
 */
export async function recordSightings(auctions) {
  if (!auctions || auctions.length === 0) return { inserted: 0, updated: 0 };
  const db = await open();

  const existing = await new Promise((resolve, reject) => {
    const t = db.transaction('auctions', 'readonly');
    const store = t.objectStore('auctions');
    const found = new Map();
    for (const a of auctions) {
      const req = store.get(a.tradeId);
      req.onsuccess = () => {
        if (req.result) found.set(req.result.tradeId, req.result);
      };
    }
    t.oncomplete = () => resolve(found);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

  let inserted = 0;
  let updated = 0;

  await new Promise((resolve, reject) => {
    const t = db.transaction('auctions', 'readwrite');
    const store = t.objectStore('auctions');
    for (const a of auctions) {
      const prev = existing.get(a.tradeId);
      if (prev) {
        prev.lastSeen = a.seenAt;
        prev.sightings = (prev.sightings || 1) + 1;
        prev.currentBid = a.currentBid;
        prev.offers = a.offers;
        if (a.expiresAt) prev.expiresAt = a.expiresAt;
        store.put(prev);
        updated++;
      } else {
        store.put({
          tradeId: a.tradeId,
          resourceId: a.resourceId,
          assetId: a.assetId,
          rating: a.rating,
          buyNow: a.buyNow,
          startingBid: a.startingBid,
          currentBid: a.currentBid,
          offers: a.offers,
          expiresAt: a.expiresAt,
          firstSeen: a.seenAt,
          lastSeen: a.seenAt,
          sightings: 1
        });
        inserted++;
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

  return { inserted, updated };
}

/** Every auction we have on record for one card. */
export async function auctionsForResource(resourceId, sinceMs) {
  const db = await open();
  const store = tx(db, 'auctions', 'readonly');
  const index = store.index('by_resource');
  const rows = await wrap(index.getAll(IDBKeyRange.only(Number(resourceId))));
  if (!sinceMs) return rows;
  const cutoff = Date.now() - sinceMs;
  return rows.filter((r) => r.lastSeen >= cutoff);
}

export async function counts() {
  const db = await open();
  const total = await wrap(tx(db, 'auctions', 'readonly').count());
  const rows = await wrap(
    tx(db, 'auctions', 'readonly')
      .index('by_lastSeen')
      .getAll(IDBKeyRange.lowerBound(Date.now() - 24 * 60 * 60 * 1000))
  );
  const players = new Set(rows.map((r) => r.resourceId));
  return { auctions: total, last24h: rows.length, playersLast24h: players.size };
}

export async function setMeta(key, value) {
  const db = await open();
  tx(db, 'meta', 'readwrite').put({ key, value });
}

export async function getMeta(key) {
  const db = await open();
  const row = await wrap(tx(db, 'meta', 'readonly').get(key)).catch(() => null);
  return row ? row.value : null;
}
