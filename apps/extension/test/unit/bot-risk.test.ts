// The Sniping Bot page's risk meter (`ui/bot-page.ts`): recommended limits
// by default, a live risk level with projections and reasons, a one-time
// acknowledgment the first time settings above low are saved, "Reset to
// recommended", and the level reported as telemetry (`lib/bot-safety.ts`).

import {
  DEFAULT_BOT_SETTINGS,
  RISK_ACKNOWLEDGMENT,
  activityEventSchema,
  type BotSettings,
} from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { riskLevelChangeEvent } from '../../src/lib/bot-safety.js';
import { createBotPage, type BotPage } from '../../src/ui/bot-page.js';

function mount(initial: BotSettings = DEFAULT_BOT_SETTINGS) {
  let stored = initial;
  const saves: BotSettings[] = [];
  const page: BotPage = createBotPage({
    getSniper: () => null,
    getUnavailableReason: () => 'test',
    prepare: async () => undefined,
    getSettings: () => stored,
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
  /** Types into a settings field and fires its change event. */
  const type = (id: string, value: string) => {
    const input = $<HTMLInputElement>(id)!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { page, root, $, saves, flush, type, current: () => stored };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bot page — risk meter', () => {
  it('shows the recommended defaults as low risk, with projections and the note', () => {
    const { $, root } = mount();
    expect($('risk')!.textContent).toBe('Risk: Low');
    expect($('risk-level')!.textContent).toBe('Low');
    expect($('risk-proj')!.textContent).toContain('About 1,500 searches and 90 buys a day');
    expect($('risk-reasons')!.children).toHaveLength(0);
    expect($('ackbox')!.hidden).toBe(true);
    expect(root.querySelector('#riskbox')!.textContent).toContain(
      "Based on limits traders have reported for EA's transfer market. Not a guarantee — EA doesn't publish its rules.",
    );
    // Every limit is editable.
    for (const id of ['delay', 's-sph', 's-bph', 's-hours', 's-flow', 's-cooldown', 'r-after', 'r-minutes'])
      expect($(id)).not.toBeNull();
  });

  it('labels each delay preset with the risk level it produces', () => {
    const { root } = mount();
    const tags = [...root.querySelectorAll<HTMLButtonElement>('button[data-delay]')].map(
      (b) => `${b.dataset.min}-${b.dataset.max} ${b.querySelector('small')!.textContent}`,
    );
    expect(tags).toEqual(['8-12 LOW', '5-8 MODERATE', '3-5 HIGH', '1-2 VERY HIGH']);
  });

  it('updates live, and holds back the first save above low until the acknowledgment', () => {
    const { $, saves, flush, type, current } = mount();
    type('s-sph', '500'); // capped by the 8 s delay: 450 × 6 h = 2,700 a day
    flush();
    expect($('risk')!.textContent).toBe('Risk: Moderate');
    expect($('risk-reasons')!.textContent).toContain('About 2,700 searches a day');
    expect(saves).toHaveLength(0);
    expect(current().safety.maxSearchesPerHour).toBe(250);

    const ack = $<HTMLInputElement>('ack-check')!;
    expect(ack.closest('label')!.textContent).toContain(RISK_ACKNOWLEDGMENT);
    const confirm = $<HTMLButtonElement>('ack-confirm')!;
    expect(confirm.disabled).toBe(true);
    confirm.disabled = false; // even forced, the unticked box blocks it
    confirm.click();
    flush();
    expect(saves).toHaveLength(0);

    ack.checked = true;
    ack.dispatchEvent(new Event('change', { bubbles: true }));
    $('ack-confirm')!.click();
    flush();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.safety.maxSearchesPerHour).toBe(500);
    expect(Number.isFinite(Date.parse(saves[0]!.riskAcknowledgedAt!))).toBe(true);

    // After that: no more prompts, but the level stays visible.
    type('s-bph', '50'); // 300 buys a day
    flush();
    expect(saves).toHaveLength(2);
    expect($('ackbox')!.hidden).toBe(true);
    expect($('risk')!.textContent).toBe('Risk: Very high');
  });

  it('resets to the recommended limits', () => {
    const { $, flush, current, root } = mount({
      ...DEFAULT_BOT_SETTINGS,
      riskAcknowledgedAt: '2026-09-24T08:00:00.000Z',
      searchDelay: { min: 1, max: 2 },
      safety: { ...DEFAULT_BOT_SETTINGS.safety, maxBuysPerHour: 60 },
    });
    expect($('risk')!.textContent).toBe('Risk: Very high');
    root.querySelector<HTMLButtonElement>('#reset-rec')!.click();
    flush();
    expect(current().searchDelay).toEqual(DEFAULT_BOT_SETTINGS.searchDelay);
    expect(current().safety).toEqual(DEFAULT_BOT_SETTINGS.safety);
    expect($('risk')!.textContent).toBe('Risk: Low');
  });

  it('asks for the acknowledgment for unconfirmed settings saved by an older build', () => {
    const { $ } = mount({ ...DEFAULT_BOT_SETTINGS, searchDelay: { min: 3, max: 5 } });
    expect($('risk')!.textContent).toBe('Risk: High');
    expect($('ackbox')!.hidden).toBe(false);
  });
});

describe('risk level telemetry', () => {
  const at = '2026-09-24T08:00:00.000Z';
  const fast: BotSettings = { ...DEFAULT_BOT_SETTINGS, searchDelay: { min: 1, max: 2 } };

  it('reports a change of level as a valid settings_change event', () => {
    const up = riskLevelChangeEvent(DEFAULT_BOT_SETTINGS, fast, at, '11111111-1111-4111-8111-111111111111');
    expect(up).toMatchObject({
      type: 'settings_change',
      metadata: { fields: ['bot.riskLevel=very_high'] },
    });
    expect(activityEventSchema.safeParse(up).success).toBe(true);

    const down = riskLevelChangeEvent(fast, DEFAULT_BOT_SETTINGS, at);
    expect(down?.metadata).toEqual({ fields: ['bot.riskLevel=low'] });
    expect(activityEventSchema.safeParse(down).success).toBe(true);
  });

  it('reports nothing when the level did not change', () => {
    expect(riskLevelChangeEvent(DEFAULT_BOT_SETTINGS, DEFAULT_BOT_SETTINGS, at)).toBeNull();
    expect(riskLevelChangeEvent(null, DEFAULT_BOT_SETTINGS, at)).toBeNull();
  });
});
