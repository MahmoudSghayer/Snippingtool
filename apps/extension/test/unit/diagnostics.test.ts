// Unit coverage for the day-one diagnostics kit (docs/06-extension.md §4):
//   - main/diagnostics.ts describes objects by key names and value types,
//     never values, without calling getters;
//   - lib/redact.ts scrubs anything secret-looking out of free text;
//   - content/diagnostics.ts only answers the extension itself;
//   - lib/diagnostics.ts assembles the report the options page copies.

import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticsResponder } from '../../src/content/diagnostics.js';
import { collectDiagnostics } from '../../src/lib/diagnostics.js';
import { scrubText } from '../../src/lib/redact.js';
import { createAdapterLog, describeKeys } from '../../src/main/diagnostics.js';

import type { AdapterDiagnostics } from '@sl/shared';

describe('describeKeys', () => {
  it('lists own and prototype keys with their types, to the given depth', () => {
    class Repo {
      search() {
        return 1;
      }
    }
    const tree = describeKeys({ Item: { repository: new Repo(), count: 3, label: 'x', nested: { deep: { deeper: 1 } } } }, 3);
    expect(tree).toEqual({
      Item: { repository: { search: 'function' }, count: 'number', label: 'string', nested: { deep: 'object' } },
    });
  });

  it('never calls a getter', () => {
    const getter = vi.fn(() => 'secret');
    const obj = {};
    Object.defineProperty(obj, 'token', { get: getter, enumerable: true });
    expect(describeKeys(obj, 2)).toEqual({ token: 'getter' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('describes arrays by length and first element', () => {
    expect(describeKeys({ items: [{ a: 1 }, { a: 2 }] }, 3)).toEqual({ items: { '#array': 'array(2)', '[0]': { a: 'number' } } });
  });

  it('reads an array\'s first element and length without calling a getter', () => {
    const first = vi.fn(() => ({ a: 1 }));
    const arr: unknown[] = [];
    Object.defineProperty(arr, '0', { get: first, enumerable: true, configurable: true });
    expect(describeKeys({ items: arr }, 3)).toEqual({ items: { '#array': 'array(1)', '[0]': 'getter' } });
    expect(first).not.toHaveBeenCalled();
  });

  it('survives cycles and huge objects', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    for (let i = 0; i < 500; i++) a[`k${i}`] = i;
    const tree = describeKeys(a, 3) as Record<string, unknown>;
    expect(tree.self).toBe('object (seen)');
    expect(Object.keys(tree).length).toBeLessThan(120);
  });

  it('scrubs key names that look like data rather than code', () => {
    const tree = describeKeys({ 'someone@example.com': 1, '1234567890123': 2, ok: 3 }, 1) as Record<string, unknown>;
    expect(JSON.stringify(tree)).not.toContain('example.com');
    expect(JSON.stringify(tree)).not.toContain('1234567890123');
    expect(tree.ok).toBe('number');
  });

  it('truncates long key names and survives a Proxy that throws', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    const tree = describeKeys({ ['a'.repeat(300)]: 1, hostile }, 2) as Record<string, unknown>;
    expect(Object.keys(tree).every((k) => k.length <= 120)).toBe(true);
    expect(tree.hostile).toBe('object (unreadable)');
  });

  it('reports a missing root by its type', () => {
    expect(describeKeys(undefined, 3)).toBe('undefined');
  });
});

describe('scrubText', () => {
  it.each([
    ['an email', 'failed for someone@example.com today', 'someone@example.com'],
    ['a JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-xyz', 'eyJhbGciOiJIUzI1NiJ9'],
    ['a UUID', 'sid 3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', '3f9a1c2e-5b7d'],
    ['a long token', 'X-UT-SID: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'AbCdEfGhIjKlMnOpQrStUvWxYz'],
    ['a long number', 'coins 7654321', '7654321'],
  ])('removes %s', (_label, input, secret) => {
    const out = scrubText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('leaves ordinary diagnostics text alone', () => {
    expect(scrubText('probe ok: shape observable (2 candidates)')).toBe('probe ok: shape observable (2 candidates)');
  });
});

describe('createAdapterLog', () => {
  it('keeps the most recent lines, scrubbed', () => {
    const log = createAdapterLog(3, () => 0);
    for (let i = 0; i < 5; i++) log.add(`line ${i} someone@example.com`);
    const lines = log.lines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('line 4');
    expect(lines.join('\n')).not.toContain('someone@example.com');
  });
});

const ADAPTER_REPORT: AdapterDiagnostics = {
  probe: { ok: true, shape: 'observable', checkedAt: 1 },
  candidates: [{ shape: 'observable', present: true }],
  servicesKeys: { Item: { searchTransferMarket: 'function' } },
  globals: { UTSearchCriteriaDTO: 'function' },
  lastMarketResponse: null,
  stats: { seen: 1, parsed: 1, failed: 0 },
  log: ['search failed for someone@example.com'],
};

describe('content diagnostics responder', () => {
  it('answers the extension itself with the adapter report', async () => {
    const adapter = { diagnostics: vi.fn(async () => ({ ok: true, latencyMs: 1, diagnostics: ADAPTER_REPORT })) };
    const respond = createDiagnosticsResponder(adapter, 'ext-id');
    await expect(respond({ type: 'diagnostics.collect' }, { id: 'ext-id' })).resolves.toEqual({ ok: true, diagnostics: ADAPTER_REPORT });
  });

  it('passes on an adapter failure as an error', async () => {
    const adapter = { diagnostics: vi.fn(async () => ({ ok: false, latencyMs: 1, error: 'adapter_unauthenticated' })) };
    const respond = createDiagnosticsResponder(adapter, 'ext-id');
    await expect(respond({ type: 'diagnostics.collect' }, { id: 'ext-id' })).resolves.toEqual({ ok: false, error: 'adapter_unauthenticated' });
  });

  it('ignores other messages and other senders', () => {
    const adapter = { diagnostics: vi.fn() };
    const respond = createDiagnosticsResponder(adapter, 'ext-id');
    expect(respond({ type: 'engine.killSwitch', payload: { active: true } }, { id: 'ext-id' })).toBeUndefined();
    expect(respond({ type: 'diagnostics.collect' }, { id: 'someone-else' })).toBeUndefined();
    expect(adapter.diagnostics).not.toHaveBeenCalled();
  });
});

describe('collectDiagnostics', () => {
  const base = { version: '0.1.0', buildTarget: 'ledger-auto', now: () => Date.UTC(2026, 8, 24) };

  it('includes the trade lifecycle counters, even with no EA tab open', async () => {
    const lifecycle = { buysWithoutItemId: 2, followed: 3, salesReported: 1 };
    const report = await collectDiagnostics({ ...base, queryTabs: async () => [], sendToTab: vi.fn(), lifecycleStats: async () => lifecycle });
    expect(report.lifecycle).toEqual(lifecycle);
    const failing = await collectDiagnostics({ ...base, queryTabs: async () => [], sendToTab: vi.fn(), lifecycleStats: async () => { throw new Error('no background'); } });
    expect(failing.lifecycle).toBeNull();
  });

  it('reports the extension alone when no EA tab is open', async () => {
    const report = await collectDiagnostics({ ...base, queryTabs: async () => [], sendToTab: vi.fn() });
    expect(report).toMatchObject({
      kind: 'nova-trade-diagnostics',
      extension: { version: '0.1.0', buildTarget: 'ledger-auto' },
      generatedAt: '2026-09-24T00:00:00.000Z',
      adapter: null,
    });
    expect(report.adapterError).toMatch(/no EA web app tab/);
  });

  it('asks the active EA tab first and includes its adapter report, scrubbed', async () => {
    const sendToTab = vi.fn(async (tabId: number) => (tabId === 2 ? { ok: true, diagnostics: ADAPTER_REPORT } : undefined));
    const report = await collectDiagnostics({ ...base, queryTabs: async () => [{ id: 1 }, { id: 2, active: true }], sendToTab });
    expect(sendToTab.mock.calls[0]![0]).toBe(2);
    expect(report.adapter?.probe).toMatchObject({ shape: 'observable' });
    expect(JSON.stringify(report)).not.toContain('someone@example.com');
  });

  it('falls back to the next tab, and reports why when none answers', async () => {
    const report = await collectDiagnostics({
      ...base,
      queryTabs: async () => [{ id: 1 }, { id: 2 }],
      sendToTab: async (tabId: number) => {
        if (tabId === 1) throw new Error('Could not establish connection');
        return { ok: false, error: 'timed out waiting for adapter response' };
      },
    });
    expect(report.adapter).toBeNull();
    expect(report.adapterError).toMatch(/timed out/);
  });

  it('rejects a malformed tab answer', async () => {
    const report = await collectDiagnostics({ ...base, queryTabs: async () => [{ id: 1 }], sendToTab: async () => ({ ok: true, diagnostics: { hello: 1 } }) });
    expect(report.adapter).toBeNull();
  });
});
