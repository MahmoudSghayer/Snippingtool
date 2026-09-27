// The userscript's drawer (userscript/launcher.ts) shares EA's page with its
// scripts: it renders in closed shadow roots, and ignore events a script made (ui/trusted-events.ts).
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

  it('is just the account view: the logo button, no tabs, no settings, no bot shortcut', () => {
    const menu = vi.fn();
    (globalThis as Record<string, unknown>).GM_registerMenuCommand = menu;
    return import('../../src/userscript/launcher.js').then(({ installLauncher }) => {
      const shadows = captureShadowRoots();
      installLauncher();
      shadows.restore();
      const root = shadows.rootOf(document.getElementById('ledger-launcher')!);
      const fab = root.querySelector<HTMLButtonElement>('.fab')!;
      expect(fab.getAttribute('aria-label')).toBe('Nova Trade account');
      expect(fab.querySelector('svg')).not.toBeNull();
      expect(fab.textContent?.trim()).toBe('');
      expect(root.querySelector('.tabs')).toBeNull();
      expect(root.querySelectorAll('.view')).toHaveLength(1);
      expect(menu.mock.calls.map((c) => c[0])).toEqual(['Open Nova Trade']);
    });
  });
});

describe('userscript launcher and the Nova AI page', () => {
  it('hides while the Nova AI page is open', async () => {
    (globalThis as Record<string, unknown>).GM_registerMenuCommand = vi.fn();
    const { installLauncher } = await import('../../src/userscript/launcher.js');
    const shadows = captureShadowRoots();
    installLauncher();
    shadows.restore();
    const fab = shadows.rootOf(document.getElementById('ledger-launcher')!).querySelector<HTMLButtonElement>('.fab')!;
    const botHost = document.createElement('div');
    botHost.id = 'ledger-bot-page';
    document.body.append(botHost);
    botHost.dataset.open = '';
    await new Promise((r) => setTimeout(r, 0));
    expect(fab.hidden).toBe(true);
    delete botHost.dataset.open;
    await new Promise((r) => setTimeout(r, 0));
    expect(fab.hidden).toBe(false);
  });
});
