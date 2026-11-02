// The userscript shim reports another tab's write to a watched key (the
// catalog) through `storage.onChanged`, via Tampermonkey's
// GM_addValueChangeListener — each tab keeps its own background copy of the
// catalog in memory and must drop it when another tab saves a new one. The
// listener is registered when the shim loads, so the GM stub goes in first.

import { afterEach, describe, expect, it, vi } from 'vitest';

type ValueListener = (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;
const valueListeners = new Map<string, ValueListener>();
vi.stubGlobal('GM_addValueChangeListener', (key: string, listener: ValueListener) => {
  valueListeners.set(key, listener);
  return valueListeners.size;
});
vi.stubGlobal('GM_getValue', (_key: string, fallback?: unknown) => fallback);
vi.stubGlobal('GM_setValue', () => undefined);
vi.stubGlobal('GM_deleteValue', () => undefined);

afterEach(() => vi.clearAllMocks());

describe('userscript browser shim — other tabs', () => {
  it("reports another tab's catalog save through storage.onChanged, and not this tab's own echo", async () => {
    const browser = (await import('../../src/userscript/browser-shim.js')).default;
    expect([...valueListeners.keys()]).toEqual(['sl.catalog.v1']);
    const seen = vi.fn();
    browser.storage.onChanged.addListener(seen);
    valueListeners.get('sl.catalog.v1')!('sl.catalog.v1', undefined, { capturedAt: 5 }, false);
    expect(seen).not.toHaveBeenCalled();
    valueListeners.get('sl.catalog.v1')!('sl.catalog.v1', { capturedAt: 1 }, { capturedAt: 5 }, true);
    expect(seen).toHaveBeenCalledWith({ 'sl.catalog.v1': { newValue: { capturedAt: 5 }, oldValue: { capturedAt: 1 } } }, 'local');
    browser.storage.onChanged.removeListener(seen);
  });
});
