/**
 * Global vitest setup: a fake IndexedDB (jsdom does not implement one) and a
 * minimal `chrome`/`browser` extension-API stub so unit tests can exercise
 * `lib/storage.ts`, `background/*` and `content/index.ts` without a real
 * browser. Individual tests override handlers on `globalThis.chrome` as
 * needed; this only guarantees the shape exists.
 */
import 'fake-indexeddb/auto';

import { vi } from 'vitest';

class MemoryStorageArea {
  private data = new Map<string, unknown>();

  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (keys == null) return Object.fromEntries(this.data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out: Record<string, unknown> = {};
    for (const k of list) if (this.data.has(k)) out[k] = this.data.get(k);
    return out;
  }

  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
  }

  async remove(keys: string | string[]) {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
  }

  async clear() {
    this.data.clear();
  }
}

const listeners = new Set<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown>();

(globalThis as any).chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
      cb?.(undefined);
    }),
    onMessage: {
      addListener: (fn: any) => listeners.add(fn),
      removeListener: (fn: any) => listeners.delete(fn),
    },
    getManifest: () => ({ version: '0.1.0', name: 'Sniper’s Ledger' }),
    getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
    lastError: undefined,
  },
  storage: {
    local: new MemoryStorageArea(),
    session: new MemoryStorageArea(),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};
