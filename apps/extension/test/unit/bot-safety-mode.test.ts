// The Sniping Bot page's safety switch (`ui/bot-page.ts`): recommended
// limits by default, custom limits only after the required acknowledgment,
// a persistent badge with a one-click way back, and the mode change reported
// as telemetry (`lib/bot-safety.ts`).

import {
  CUSTOM_LIMITS_ACKNOWLEDGMENT,
  DEFAULT_BOT_SETTINGS,
  DEFAULT_GOVERNOR_SETTINGS,
  activityEventSchema,
  type BotSettings,
} from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safetyModeChangeEvent } from '../../src/lib/bot-safety.js';
import { createBotPage, type BotPage } from '../../src/ui/bot-page.js';

function mount(initial: BotSettings = DEFAULT_BOT_SETTINGS) {
  let stored = initial;
  const saves: BotSettings[] = [];
  const page: BotPage = createBotPage({
    getSniper: () => null,
    getUnavailableReason: () => 'test',
    prepare: async () => undefined,
    getSettings: () => stored,
    getGovernorSettings: () => DEFAULT_GOVERNOR_SETTINGS,
    saveSettings: async (next) => {
      stored = next;
      saves.push(next);
    },
    getFilters: () => [],
    saveFilters: async () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => null,
  });
  page.open();
  const root = document.getElementById('ledger-bot-page')!.shadowRoot!;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T | null;
  const flush = () => vi.advanceTimersByTime(500);
  return { page, root, $, saves, flush, current: () => stored };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bot page — safety mode', () => {
  it('starts in recommended mode with presets derived from the caps, none called risky', () => {
    const { root, $ } = mount();
    expect($('mode')!.textContent).toContain('Recommended limits');
    const presets = [...root.querySelectorAll<HTMLButtonElement>('button[data-delay]')];
    expect(presets.map((p) => p.querySelector('small')!.textContent)).toEqual([
      'CAREFUL',
      'BALANCED',
      'FASTEST ALLOWED',
    ]);
    // Default caps: 30 actions/hour, 0.35 buys per search -> 162 s minimum.
    for (const p of presets) expect(Number(p.dataset.min)).toBeGreaterThanOrEqual(162);
    expect(root.querySelector('.page')!.textContent).not.toMatch(/risky/i);
    expect(root.querySelector('button[data-safety]')).toBeNull();
  });

  it('turning the recommended limits off needs the checkbox, then stores the acknowledgment', () => {
    const { $, saves, flush, current } = mount();
    $('mode-custom')!.click();

    const ack = $<HTMLInputElement>('ack-custom')!;
    expect(ack.closest('label')!.textContent).toContain(CUSTOM_LIMITS_ACKNOWLEDGMENT);
    const confirm = $<HTMLButtonElement>('mode-custom-confirm')!;
    expect(confirm.disabled).toBe(true);

    // Clicking without the checkbox does nothing, even if the button is
    // forced enabled.
    confirm.disabled = false;
    confirm.click();
    flush();
    expect(saves).toHaveLength(0);
    expect(current().safetyMode).toBe('recommended');

    ack.checked = true;
    ack.dispatchEvent(new Event('change', { bubbles: true }));
    expect($<HTMLButtonElement>('mode-custom-confirm')!.disabled).toBe(false);
    $('mode-custom-confirm')!.click();
    flush();

    expect(saves).toHaveLength(1);
    expect(saves[0]!.safetyMode).toBe('custom');
    expect(Number.isFinite(Date.parse(saves[0]!.customRiskAcknowledgedAt!))).toBe(true);
    expect($('mode')!.textContent).toContain('Custom limits — higher ban risk');
  });

  it('shows the custom badge while custom mode is on, with a one-click way back', () => {
    const { $, saves, flush } = mount({
      ...DEFAULT_BOT_SETTINGS,
      safetyMode: 'custom',
      customRiskAcknowledgedAt: '2026-09-24T08:00:00.000Z',
    });
    expect($('mode')!.textContent).toContain('Custom limits — higher ban risk');
    $('back-recommended')!.click();
    flush();
    expect(saves.at(-1)!.safetyMode).toBe('recommended');
    expect(saves.at(-1)!.customRiskAcknowledgedAt).toBeNull();
    expect($('mode')!.textContent).toContain('Recommended limits');
    expect($('back-recommended')).toBeNull();
  });

  it('treats a stored custom mode without an acknowledgment as recommended', () => {
    const { $ } = mount({ ...DEFAULT_BOT_SETTINGS, safetyMode: 'custom', customRiskAcknowledgedAt: null });
    expect($('mode')!.textContent).toContain('Recommended limits');
  });
});

describe('safety mode telemetry', () => {
  const at = '2026-09-24T08:00:00.000Z';
  const rec = { safetyMode: 'recommended', customRiskAcknowledgedAt: null } as const;
  const custom = { safetyMode: 'custom', customRiskAcknowledgedAt: at } as const;

  it('reports a switch to custom and back as a valid settings_change event', () => {
    const on = safetyModeChangeEvent(rec, custom, at, '11111111-1111-4111-8111-111111111111');
    expect(on).toMatchObject({
      type: 'settings_change',
      metadata: { fields: ['bot.safetyMode=custom'] },
    });
    expect(activityEventSchema.safeParse(on).success).toBe(true);

    const off = safetyModeChangeEvent(custom, rec, at);
    expect(off?.metadata).toEqual({ fields: ['bot.safetyMode=recommended'] });
    expect(activityEventSchema.safeParse(off).success).toBe(true);
  });

  it('reports nothing when the mode did not change', () => {
    expect(safetyModeChangeEvent(rec, rec, at)).toBeNull();
    expect(safetyModeChangeEvent(custom, custom, at)).toBeNull();
    // Unacknowledged custom is still recommended.
    expect(
      safetyModeChangeEvent(rec, { safetyMode: 'custom', customRiskAcknowledgedAt: null }, at),
    ).toBeNull();
  });
});
