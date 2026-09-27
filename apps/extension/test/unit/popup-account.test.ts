// The signed-in account view (`popup/app.ts`): plan, the "Share usage data"
// switch (the telemetry opt-out, Terms §8) and Sign out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

let optedOut = false;
const send = vi.fn(async (type: string, payload?: unknown) => {
  switch (type) {
    case 'auth.status':
      return { authenticated: true };
    case 'license.bootstrap':
      return { subscription: null, killSwitchActive: false };
    case 'settings.get':
      return { telemetryOptOut: optedOut };
    case 'settings.set':
      optedOut = (payload as { telemetryOptOut: boolean }).telemetryOptOut;
      return { telemetryOptOut: optedOut };
    default:
      return null;
  }
});

vi.mock('../../src/lib/bg-client.js', () => ({
  send: (type: string, payload?: unknown) => send(type, payload),
  BackgroundError: class extends Error {},
}));

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  optedOut = false;
  send.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as Record<string, unknown>).CSS ??= { escape: (s: string) => s };
  trustTestEvents();
});
afterEach(() => untrustedEvents());

describe('account view — Share usage data', () => {
  it('shows the switch on, and turning it off opts out of telemetry (and back)', async () => {
    const { mountPopup } = await import('../../src/popup/app.js');
    const app = document.getElementById('app')!;
    mountPopup(app);
    await settle();

    const sw = () => app.querySelector<HTMLButtonElement>('#share-usage')!;
    expect(sw().getAttribute('role')).toBe('switch');
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(app.textContent).toContain('Anonymous usage stats that help improve Nova Trade. No personal data.');

    sw().click();
    await settle();
    expect(send).toHaveBeenCalledWith('settings.set', { telemetryOptOut: true });
    expect(sw().getAttribute('aria-checked')).toBe('false');

    sw().click();
    await settle();
    expect(send).toHaveBeenCalledWith('settings.set', { telemetryOptOut: false });
    expect(optedOut).toBe(false);
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('ignores a click a page script makes', async () => {
    const { mountPopup } = await import('../../src/popup/app.js');
    const app = document.getElementById('app')!;
    mountPopup(app);
    await settle();
    untrustedEvents();
    app.querySelector<HTMLButtonElement>('#share-usage')!.click();
    await settle();
    expect(send).not.toHaveBeenCalledWith('settings.set', expect.anything());
  });
});
