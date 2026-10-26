// The Nova AI page itself, mounted as content/index.ts mounts it: a cold
// open, warm reopens, typing in the player box against a 20k catalog, the
// per-second tick, and Gallery mode with a full list and fut.gg's Sets
// loaded. jsdom does no layout, so these are the JavaScript and DOM-build
// costs only — the part the optimisation targets.
import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotModeSettings, type FutggSetSummary, type GalleryGrade, type GalleryState } from '@sl/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';
import { perf } from '../../src/lib/perf.js';
import { createBotPage } from '../../src/ui/bot-page.js';
import { captureShadowRoots, trustTestEvents, untrustedEvents } from '../unit/ui-test-helpers.js';

import { makeCatalog, makeFutggSets, makeGallery, makeLineup } from './fixtures.js';
import { createSuite } from './harness.js';

import type { Catalog } from '../../src/model/catalog.js';

const suite = createSuite('bot-page');
afterAll(() => suite.flush());

// Timers faked so the page's intervals are under control; `performance`
// stays real for the measurements.
const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  document.body.innerHTML = '';
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

function makeSniper(): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        move: vi.fn(),
        club: vi.fn(),
        owned: async (ids: number[]) => ({ ok: true as const, owned: ids.slice(0, 3), latencyMs: 1 }),
        onAuctions: () => () => undefined,
        onBuyable: () => () => undefined,
        onProbe: () => () => undefined,
        onShape: () => () => undefined,
      },
      getFilters: () => [],
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    { ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: '2026-09-24T00:00:00.000Z' },
  );
}

function mount(catalog: Catalog, mode: BotModeSettings, gallery: GalleryState, futgg?: { sets: FutggSetSummary[] }) {
  const sniper = makeSniper();
  sniper.setGallery(gallery);
  let catalogCalls = 0;
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => ({ ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: '2026-09-24T00:00:00.000Z' }),
    saveSettings: async () => undefined,
    getModeSettings: () => mode,
    saveModeSettings: async () => undefined,
    getGallery: () => sniper.getGallery(),
    saveGallery: async (next) => {
      sniper.setGallery(next);
    },
    ...(futgg
      ? {
          futggSets: async () => futgg.sets,
          futggLineup: async (setId: number, grade: GalleryGrade) => {
            const i = setId - 1000;
            const set = futgg.sets[i];
            return set ? makeLineup(set, grade, i) : null;
          },
        }
      : {}),
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => {
      catalogCalls++;
      return catalog;
    },
  });
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  shadows.restore();
  return { page, root, sniper, calls: () => catalogCalls };
}

describe('Nova AI page', () => {
  const catalog = makeCatalog(20_000);

  it('cold open, warm reopens, the catalog poll and the per-second tick (Snipe mode)', async () => {
    const { page, root, calls } = mount(catalog, DEFAULT_BOT_MODE_SETTINGS, { budget: 0, spent: 0, cards: [] });
    const t0 = performance.now();
    page.open();
    const visible = performance.now() - t0;
    await vi.advanceTimersByTimeAsync(10); // the catalog answer lands, the form is drawn with it
    suite.record('open cold → visible', visible);
    suite.record('open cold → catalog drawn', performance.now() - t0);
    expect(root.querySelector('#nf-player')).not.toBeNull();

    suite.bench(
      'reopen warm (close + open)',
      () => {
        page.close();
        page.open();
      },
      { runs: 10 },
    );
    await vi.advanceTimersByTimeAsync(10);

    // What the page asks for while it sits open for 30 s doing nothing.
    const before = calls();
    const r = suite.bench(
      '30 s idle open (timers only)',
      () => {
        const c = calls();
        vi.advanceTimersByTime(30_000);
        return { catalogGets: calls() - c };
      },
      { runs: 3, warmup: 0 },
    );
    expect(calls()).toBeGreaterThanOrEqual(before);
    suite.record('catalog.get sends per 30 s idle', r.meta?.catalogGets ?? 0);
    page.close();
  }, 120_000);

  it('typing a name in the player box against 20k players', async () => {
    const { page, root } = mount(catalog, DEFAULT_BOT_MODE_SETTINGS, { budget: 0, spent: 0, cards: [] });
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    const input = root.querySelector<HTMLInputElement>('#nf-player')!;
    const type = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    suite.bench(
      'typing "bellingham" (10 input events)',
      () => {
        for (let i = 1; i <= 10; i++) type('bellingham'.slice(0, i));
        return { suggestions: root.querySelectorAll('#nf-suggest button').length };
      },
      { runs: 5 },
    );
    suite.bench('one keystroke "an" (common)', () => {
      type('an');
    });
    suite.bench('one keystroke "silva"', () => {
      type('silva');
    });
    page.close();
  }, 120_000);

  it('Gallery mode: 300 cards over 20 Sets, 250 fut.gg Sets loaded', async () => {
    const gallery = makeGallery(300, 20);
    const sets = makeFutggSets(250);
    const { page, root } = mount(catalog, { ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, gallery, { sets });
    const t0 = performance.now();
    page.open();
    suite.record('gallery open cold → visible', performance.now() - t0);
    await vi.advanceTimersByTimeAsync(10);
    (root.querySelector('#g-futgg') as HTMLElement).click();
    const t1 = performance.now();
    await vi.advanceTimersByTimeAsync(10);
    suite.record('fut.gg Sets drawn after the answer (250 Sets)', performance.now() - t1);
    expect(root.querySelector('.g-spacer')).not.toBeNull();
    suite.bench(
      'gallery reopen warm (250 Sets listed)',
      () => {
        page.close();
        page.open();
      },
      { runs: 10 },
    );
    await vi.advanceTimersByTimeAsync(10);
    // The Gallery feed tab: its first draw and the per-second tick after it.
    (root.querySelector('.ftab[data-feed="gallery"]') as HTMLElement).click();
    perf.reset();
    perf.enable(true);
    suite.bench(
      '1 s tick x10 (gallery feed open, nothing changed)',
      () => {
        vi.advanceTimersByTime(10_000);
      },
      { runs: 3 },
    );
    perf.enable(false);
    for (const [name, v] of Object.entries(perf.snapshot().summary)) suite.record(`  ↳ ${name} (mean of ${v.n})`, v.mean);
    for (const [name, v] of Object.entries(perf.snapshot().counts)) suite.record(`  ↳ count ${name}`, v);
    // A Set ticked and added: lineup, club check, list update, redraw.
    const first = root.querySelector<HTMLInputElement>('input[data-futgg]')!;
    first.checked = true;
    first.dispatchEvent(new Event('change', { bubbles: true }));
    const t2 = performance.now();
    (root.querySelector('#g-add') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(50);
    suite.record('add 1 Set (lineup + club check + redraw)', performance.now() - t2);
    page.close();
  }, 120_000);
});
