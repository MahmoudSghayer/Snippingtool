/*
 * lifecycle-db.ts — the trade lifecycle's records (lib/trade-lifecycle.ts)
 * in IndexedDB, in the extension's own origin. Its own database, not a
 * new store in `ledger` (store/db.ts): that one would need a version bump
 * and an upgrade path for every existing install, for a store that shares
 * nothing with it. One row per item, keyed by EA's itemId.
 */
import type { LifecycleRecord, LifecycleStore } from '../lib/trade-lifecycle.js';

const DB_NAME = 'ledger-lifecycle';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'itemId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Test-only: drop the cached connection. */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) (await dbPromise.catch(() => null))?.close();
  dbPromise = null;
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        // Resolved on the transaction's completion, so a `put` is durable
        // before the caller goes on to report the sale it records.
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idbLifecycleStore: LifecycleStore = {
  get: (itemId) => request('readonly', (s) => s.get(itemId) as IDBRequest<LifecycleRecord | undefined>),
  put: async (record) => {
    await request('readwrite', (s) => s.put(record));
  },
  delete: async (itemId) => {
    await request('readwrite', (s) => s.delete(itemId));
  },
  all: () => request('readonly', (s) => s.getAll() as IDBRequest<LifecycleRecord[]>),
};
