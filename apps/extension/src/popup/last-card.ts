/*
 * last-card.ts — finds the most recently observed resourceId so the popup
 * can show a "current card" summary (floor/median/sell-through/max snipe),
 * the same numbers `ui/panel.ts` shows on the EA page itself.
 *
 * `store/db.ts` (out of this pass's file ownership — see apps/extension's
 * PHASE 10 brief) already exposes exactly the read this needs
 * (`auctionsForResource`) and `background/index.ts` already exposes a
 * `summary` message that calls it, so this file's only job is the one piece
 * neither of those already does: knowing *which* resourceId to ask for.
 * `content/index.ts` tracks that as an in-memory `lastResourceId` (never
 * persisted, since that file is owned elsewhere this pass), so the popup
 * can't read it directly — instead this opens the extension's own
 * `ledger` IndexedDB database (the same one `store/db.ts` writes to; same
 * origin — background, popup and options are all `chrome-extension://<id>`)
 * read-only, and walks the `by_lastSeen` index backwards for the single
 * most recently observed row's resourceId.
 *
 * Deliberately defensive: opened with **no explicit version** so this file
 * never drives a schema upgrade (that stays store/db.ts's job) — if the
 * database or the `auctions` store doesn't exist yet (fresh install, no
 * searches recorded), or the shape doesn't match what's expected, this
 * resolves to `null` rather than throwing, and the popup shows its empty
 * state instead of an error.
 */

const DB_NAME = 'ledger';
const STORE_NAME = 'auctions';
const INDEX_NAME = 'by_lastSeen';

export async function findMostRecentResourceId(): Promise<number | null> {
  if (typeof indexedDB === 'undefined') return null;

  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // No onupgradeneeded handler: if this somehow runs before
      // background ever has, indexedDB creates an empty DB with no object
      // stores, and the `contains` check right below treats that the same
      // as "no data yet".
    });
  } catch {
    return null;
  }

  try {
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    if (!store.indexNames.contains(INDEX_NAME)) return null;

    return await new Promise<number | null>((resolve, reject) => {
      const req = store.index(INDEX_NAME).openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        const resourceId = (cursor?.value as { resourceId?: unknown } | undefined)?.resourceId;
        resolve(typeof resourceId === 'number' ? resourceId : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}
