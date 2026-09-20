/*
 * db.ts — the observation store.
 *
 * Ported from milestone 1's `src/store/db.js` (typed, logic unchanged). Every
 * listing the web app shows you gets written here, in the extension's own
 * origin (not ea.com's, so clearing the site's data doesn't wipe your
 * history). Nothing in here is ever uploaded anywhere — this is the terminus
 * of the observation flow (docs/01-architecture.md, trust boundaries table).
 *
 * One row per auction, not per sighting. Keeping firstSeen/lastSeen on a
 * single row is what lets us tell later whether a card sold or just expired.
 */
import type { AuctionRow } from '../model/prices.js';
import type { TrimmedAuction } from '@sl/shared';


const DB_NAME = 'ledger';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function open(): Promise<IDBDatabase> {
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

/** Test-only: close the cached connection (if any) and drop it, so a fresh
 * `open()` reopens and, in `fake-indexeddb`, re-runs `onupgradeneeded`
 * against a clean database. Awaited (not fire-and-forget) so a test's
 * `indexedDB.deleteDatabase()` right after this never races an still-open
 * connection — a real `deleteDatabase()` blocks until every connection to
 * that database is closed. */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
  }
  dbPromise = null;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface RecordResult {
  inserted: number;
  updated: number;
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
export async function recordSightings(auctions: TrimmedAuction[]): Promise<RecordResult> {
  if (!auctions || auctions.length === 0) return { inserted: 0, updated: 0 };
  const db = await open();

  const existing = await new Promise<Map<string, AuctionRow>>((resolve, reject) => {
    const t = db.transaction('auctions', 'readonly');
    const store = t.objectStore('auctions');
    const found = new Map<string, AuctionRow>();
    for (const a of auctions) {
      const req = store.get(a.tradeId);
      req.onsuccess = () => {
        if (req.result) found.set((req.result as AuctionRow).tradeId, req.result as AuctionRow);
      };
    }
    t.oncomplete = () => resolve(found);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

  let inserted = 0;
  let updated = 0;

  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('auctions', 'readwrite');
    const store = t.objectStore('auctions');
    for (const a of auctions) {
      const prev = existing.get(a.tradeId);
      if (prev) {
        prev.lastSeen = a.seenAt;
        prev.sightings = (prev.sightings || 1) + 1;
        if (a.expiresAt) prev.expiresAt = a.expiresAt;
        store.put(prev);
        updated++;
      } else {
        const record: AuctionRow = {
          tradeId: a.tradeId,
          resourceId: a.resourceId,
          buyNow: a.buyNow,
          expiresAt: a.expiresAt,
          firstSeen: a.seenAt,
          lastSeen: a.seenAt,
          sightings: 1,
        };
        store.put(record);
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
export async function auctionsForResource(resourceId: number, sinceMs?: number): Promise<AuctionRow[]> {
  const db = await open();
  const store = tx(db, 'auctions', 'readonly');
  const index = store.index('by_resource');
  const rows = await wrap<AuctionRow[]>(index.getAll(IDBKeyRange.only(Number(resourceId))));
  if (!sinceMs) return rows;
  const cutoff = Date.now() - sinceMs;
  return rows.filter((r) => r.lastSeen >= cutoff);
}

export interface Counts {
  auctions: number;
  last24h: number;
  playersLast24h: number;
}

export async function counts(): Promise<Counts> {
  const db = await open();
  const total = await wrap(tx(db, 'auctions', 'readonly').count());
  const rows = await wrap<AuctionRow[]>(
    tx(db, 'auctions', 'readonly')
      .index('by_lastSeen')
      .getAll(IDBKeyRange.lowerBound(Date.now() - 24 * 60 * 60 * 1000)),
  );
  const players = new Set(rows.map((r) => r.resourceId));
  return { auctions: total, last24h: rows.length, playersLast24h: players.size };
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await open();
  tx(db, 'meta', 'readwrite').put({ key, value });
}

export async function getMeta<T = unknown>(key: string): Promise<T | null> {
  const db = await open();
  const row = await wrap<{ key: string; value: T } | undefined>(tx(db, 'meta', 'readonly').get(key)).catch(
    () => undefined,
  );
  return row ? row.value : null;
}
