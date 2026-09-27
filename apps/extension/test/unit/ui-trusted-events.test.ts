// The in-page panel (ui/panel.ts) and the userscript's drawer
// (userscript/launcher.ts) share EA's page with its scripts: both render in
// closed shadow roots, and ignore events a script made (ui/trusted-events.ts).
// The Sniping Bot page has its own tests (bot-risk.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onTrusted } from '../../src/ui/trusted-events.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

beforeEach(() => {
  document.body.innerHTML = '';
  untrustedEvents();
});
afterEach(() => {
  untrustedEvents();
});

describe('onTrusted', () => {
  it('runs the handler for a trusted event only', () => {
    const el = document.createElement('button');
    const handler = vi.fn();
    onTrusted(el, 'click', handler);
    el.click(); // script-made: isTrusted is false
    el.dispatchEvent(new MouseEvent('click'));
    expect(handler).not.toHaveBeenCalled();

    trustTestEvents();
    el.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('in-page panel', () => {
  it('is closed to page scripts, and its bot button ignores script clicks', async () => {
    const { createPanel } = await import('../../src/ui/panel.js');
    const shadows = captureShadowRoots();
    const panel = createPanel();
    shadows.restore();
    const host = document.getElementById('ledger-root')!;
    expect(host.shadowRoot).toBeNull();

    const open = vi.fn();
    panel.setBotLauncher(open);
    const button = shadows.rootOf(host).getElementById('bot-open') as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    button.click();
    expect(open).not.toHaveBeenCalled();
    trustTestEvents();
    button.click();
    expect(open).toHaveBeenCalledTimes(1);

    // Replacing the launcher does not stack a second listener.
    const other = vi.fn();
    panel.setBotLauncher(other);
    button.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('userscript launcher', () => {
  it('uses closed shadow roots, and its button ignores script clicks', async () => {
    (globalThis as Record<string, unknown>).GM_registerMenuCommand = vi.fn();
    // jsdom has no CSS.escape; the popup's lookups use it once the drawer opens.
    (globalThis as Record<string, unknown>).CSS ??= { escape: (s: string) => s };
    const { installLauncher } = await import('../../src/userscript/launcher.js');
    const shadows = captureShadowRoots();
    installLauncher();
    shadows.restore();
    const host = document.getElementById('ledger-launcher')!;
    expect(host.shadowRoot).toBeNull();
    const root = shadows.rootOf(host);
    for (const view of root.querySelectorAll('.view')) expect(view.shadowRoot).toBeNull();

    const fab = root.querySelector<HTMLButtonElement>('.fab')!;
    const drawer = root.querySelector<HTMLElement>('.drawer')!;
    fab.click();
    expect(drawer.hidden).toBe(true);
    trustTestEvents();
    fab.click();
    expect(drawer.hidden).toBe(false);
  });
});
