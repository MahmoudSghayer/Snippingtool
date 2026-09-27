// The assist hotkeys on EA's page (P0 Task 13, item 1): the keydown
// listener content/index.ts installs, the confirm overlay, and what they
// leave alone. EA's own keys (Enter, Space, the arrows) are never
// prevented, and a key press or click a page script makes (`isTrusted`
// false) can neither open nor confirm a buy.
import { DEFAULT_ASSIST_HOTKEYS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDetailsFor, installAssistHotkeys, selectionDetailsFor } from '../../src/content/assist-keys.js';
import { AssistEngine } from '../../src/engine/assist.js';
import { Governor } from '../../src/engine/governor.js';
import { createConfirmOverlay } from '../../src/ui/confirm-overlay.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

import type { AdapterClient } from '../../src/content/adapter-client.js';
import type { ScoredOpportunity } from '../../src/engine/ranker.js';

function candidate(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    resourceId: 20801,
    tradeId: 't1',
    price: 10_000,
    summary: {} as ScoredOpportunity['summary'],
    ev: 900,
    netAtMedian: 1_400,
    probabilityOfSale: 0.7,
    name: 'Cristiano Ronaldo',
    rating: 86,
    ...overrides,
  };
}

// A fresh page per test, so no earlier test's listener is still attached.
let doc: Document;

function setup(ranked: ScoredOpportunity[] = [candidate()]) {
  const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
  const adapter = { buy } as unknown as AdapterClient;
  doc = document.implementation.createHTMLDocument('EA');
  const shadows = captureShadowRoots();
  const overlay = createConfirmOverlay(doc);
  shadows.restore();
  let engine: AssistEngine | null = null;
  engine = new AssistEngine({
    governor: new Governor({ actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 1, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 }),
    adapter,
    getFilters: () => [],
    getRanked: () => ranked,
    onFilterSelected: vi.fn(),
    onAttempt: vi.fn(),
    onTrade: vi.fn(),
    confirm: {
      show: (c) =>
        overlay.show(confirmDetailsFor(c, DEFAULT_ASSIST_HOTKEYS), {
          onConfirm: () => engine?.confirmPending(),
          onCancel: () => engine?.cancelPending(),
        }),
      hide: () => overlay.hide(),
    },
    onSelectionChange: (tradeId) => {
      const i = ranked.findIndex((c) => c.tradeId === tradeId);
      if (i >= 0) overlay.showSelection(selectionDetailsFor(ranked[i]!, i, ranked.length, DEFAULT_ASSIST_HOTKEYS));
    },
  });
  installAssistHotkeys(doc, () => engine);
  // EA's own handler for its keys, which must still see them.
  const eaSaw: string[] = [];
  doc.addEventListener('keydown', (e) => eaSaw.push(e.key));
  return { engine, buy, overlay, shadows, eaSaw };
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  doc.body.dispatchEvent(e);
  return e;
}
const altB = { key: '∫', code: 'KeyB', altKey: true };

beforeEach(() => {
  document.body.innerHTML = '';
  untrustedEvents();
});
afterEach(() => {
  untrustedEvents();
});

describe('assist hotkeys on the page', () => {
  it('never prevents EA’s Enter, Space or arrow keys, and never buys on them', async () => {
    trustTestEvents();
    const { buy, overlay, eaSaw } = setup();
    for (const init of [
      { key: 'Enter', code: 'Enter' },
      { key: ' ', code: 'Space' },
      { key: 'ArrowUp', code: 'ArrowUp' },
      { key: 'ArrowDown', code: 'ArrowDown' },
      { key: 'ArrowRight', code: 'ArrowRight' },
    ]) {
      expect(keydown(init).defaultPrevented).toBe(false);
    }
    expect(eaSaw).toEqual(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowRight']);
    expect(overlay.isOpen()).toBe(false);
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
  });

  it('Alt+B opens a confirm overlay naming the card, its price and the expected profit; a second Alt+B buys', async () => {
    trustTestEvents();
    const { buy, overlay, shadows } = setup();
    expect(keydown(altB).defaultPrevented).toBe(true);
    expect(overlay.isOpen()).toBe(true);
    const host = doc.getElementById('ledger-confirm')!;
    expect(host.shadowRoot).toBeNull(); // closed to page scripts
    const text = shadows.rootOf(host).textContent ?? '';
    expect(text).toContain('Cristiano Ronaldo');
    expect(text).toContain('86');
    expect(text).toContain('10,000');
    expect(text).toContain('+1,400');
    expect(text).toContain('Alt+B');
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();

    keydown(altB);
    await vi.waitFor(() => expect(buy).toHaveBeenCalledWith('t1', 10_000, { resourceId: 20801 }));
    expect(overlay.isOpen()).toBe(false);
  });

  it('names a card by its id when the item data carried no name', () => {
    expect(confirmDetailsFor(candidate({ name: undefined, rating: undefined }), DEFAULT_ASSIST_HOTKEYS).title).toBe('#20801');
  });

  it('Escape cancels, and still reaches EA', async () => {
    trustTestEvents();
    const { buy, overlay, eaSaw } = setup();
    keydown(altB);
    const esc = keydown({ key: 'Escape', code: 'Escape' });
    expect(esc.defaultPrevented).toBe(false);
    expect(eaSaw).toContain('Escape');
    expect(overlay.isOpen()).toBe(false);
    keydown(altB); // opens a fresh overlay, does not confirm the cancelled one
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
  });

  it('the overlay’s Confirm button buys on a user’s click', async () => {
    trustTestEvents();
    const { buy, shadows } = setup();
    keydown(altB);
    const root = shadows.rootOf(doc.getElementById('ledger-confirm')!);
    (root.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(buy).toHaveBeenCalledTimes(1));
  });

  it('a synthetic keydown or click never opens or confirms a buy', async () => {
    const { buy, overlay, shadows } = setup();
    // Untrusted (script-made) chords: ignored outright.
    expect(keydown(altB).defaultPrevented).toBe(false);
    keydown(altB);
    expect(overlay.isOpen()).toBe(false);

    // Opened by the user, then a script clicks Confirm and presses Alt+B.
    trustTestEvents();
    keydown(altB);
    untrustedEvents();
    const root = shadows.rootOf(doc.getElementById('ledger-confirm')!);
    (root.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    keydown(altB);
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
    expect(overlay.isOpen()).toBe(true);
  });

  it('ignores chords typed into a text field', () => {
    trustTestEvents();
    const { overlay } = setup();
    const input = doc.createElement('input');
    doc.body.appendChild(input);
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...altB });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(overlay.isOpen()).toBe(false);
  });

  it('Alt+Down shows which listing is now selected, by name', () => {
    trustTestEvents();
    const { shadows } = setup([candidate(), candidate({ tradeId: 't2', name: 'Kylian Mbappé', rating: 91, price: 250_000 })]);
    const e = keydown({ key: '∆', code: 'ArrowDown', altKey: true });
    expect(e.defaultPrevented).toBe(true);
    const text = shadows.rootOf(doc.getElementById('ledger-confirm')!).textContent ?? '';
    expect(text).toContain('Kylian Mbappé 91');
    expect(text).toContain('2/2');
    expect(text).toContain('250,000');
  });
});
