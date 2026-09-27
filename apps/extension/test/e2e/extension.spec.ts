/*
 * extension.spec.ts — loads the built `ledger` dist into real Chromium
 * against the mock EA web app fixture and asserts: the panel appears,
 * observations get recorded, the bundle probe reports ok, and (as a
 * static check, no browser needed) the `ledger` build contains no
 * reference to `engine/autobuyer.ts` at all.
 *
 * Run locally:
 *   pnpm --filter @sl/extension build:ledger
 *   pnpm --filter @sl/extension test:e2e
 *
 * Extension loading requires a *headed* Chromium context
 * (`--load-extension` + `launchPersistentContext`) — Chrome does not load
 * unpacked extensions in classic headless mode. This container has no
 * display, so CI/sandbox runs go through `xvfb-run` instead of a real
 * display:
 *   xvfb-run -a pnpm --filter @sl/extension test:e2e
 * On a machine with a real display (or Xvfb already running under
 * `$DISPLAY`), the two commands above are enough on their own.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test, type Page } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(dirname, '..', '..');
const distDir = path.join(extensionDir, 'dist', 'ledger');
const fixtureDir = path.join(dirname, '..', 'fixtures', 'mock-ea-app');
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const PAGE_URL = 'https://www.ea.com/en/ultimate-team/web-app/index.html';

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

function findNode(node: CdpNode, id: string): CdpNode | null {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** `#id` inside the panel's shadow root: its text and class. The panel's
 * root is closed (ui/panel.ts), so no script on the page — and so no
 * `page.evaluate` — can reach it; DevTools can, so this reads it over CDP. */
async function panelElement(page: Page, id: string): Promise<{ text: string; className: string } | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    const host = findNode(root, 'ledger-root');
    const el = host?.shadowRoots?.[0] ? findNode(host.shadowRoots[0], id) : null;
    if (!el) return null;
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: el.backendNodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return { text: this.textContent || "", className: String(this.className) }; }',
      returnByValue: true,
    })) as { result: { value: { text: string; className: string } } };
    return result.value;
  } finally {
    await cdp.detach();
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test.describe('ledger build contents', () => {
  test('never contains the autobuyer module, in any file', () => {
    test.skip(!existsSync(distDir), `dist/ledger not built — run "pnpm --filter @sl/extension build:ledger" first`);
    const files = walk(distDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      expect(contents.toLowerCase(), `${path.relative(distDir, file)} must not mention "autobuyer"`).not.toContain('autobuyer');
    }
  });
});

test.describe('extension against the mock EA web app', () => {
  test.skip(!existsSync(distDir), `dist/ledger not built — run "pnpm --filter @sl/extension build:ledger" first`);

  test('panel appears, observations are recorded, and the bundle probe reports ok', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      executablePath: existsSync(chromiumPath) ? chromiumPath : undefined,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, '--no-sandbox'],
    });

    try {
      await context.route('https://www.ea.com/**', async (route) => {
        const url = new URL(route.request().url());

        if (url.pathname.endsWith('/transfermarket')) {
          const payload = await import('../fixtures/mock-ea-app/payloads.js');
          await route.fulfill({ json: payload.SEARCH_PAGE_1 });
          return;
        }
        if (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/web-app/')) {
          await route.fulfill({ path: path.join(fixtureDir, 'index.html'), contentType: 'text/html' });
          return;
        }
        if (url.pathname.endsWith('mock-service-layer.js')) {
          await route.fulfill({ path: path.join(fixtureDir, 'mock-service-layer.js'), contentType: 'application/javascript' });
          return;
        }
        if (url.pathname.endsWith('payloads.js')) {
          await route.fulfill({ path: path.join(fixtureDir, 'payloads.js'), contentType: 'application/javascript' });
          return;
        }
        await route.continue();
      });

      const page = await context.newPage();
      await page.goto(PAGE_URL, { waitUntil: 'load' });

      // The panel is a shadow-DOM host appended by content.js.
      const host = page.locator('#ledger-root');
      await expect(host).toHaveCount(1, { timeout: 15_000 });

      // The mock page fires one passive search 50ms after load
      // (mock-service-layer.js) — usually *before* the ISOLATED-world
      // content script (`run_at: document_idle`) is listening on this
      // instantly-fulfilled page, so that first observation may be lost.
      // The "Auctions recorded" row moving off "—" is not proof of an
      // observation either (content/index.ts fills it from the boot-time
      // `counts` reply). So, with the panel host proving the content script
      // is live, trigger the same passive search again via the fixture's
      // own hook and assert on the counters that only move once an
      // observation has crossed from the MAIN world into content.js.
      await page.evaluate(() => (window as unknown as { __mock: { triggerPassiveSearch(): Promise<void> } }).__mock.triggerPassiveSearch());
      // The panel's shadow root is closed to page scripts.
      expect(await host.evaluate((el) => el.shadowRoot)).toBeNull();
      const panelNumber = async (id: string) => Number(((await panelElement(page, id))?.text ?? '').replace(/[^\d]/g, ''));
      await expect.poll(() => panelNumber('searches'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => panelNumber('total'), { timeout: 15_000 }).toBeGreaterThan(0);

      // The bundle probe should report ok — the fixture's `window.services`
      // matches adapter.ts's ASSUMED SHAPE exactly, so the status dot must
      // not be in its warn state.
      const dotClass = (await panelElement(page, 'dot'))?.className;
      expect(dotClass).not.toContain('warn');

      const statusText = (await panelElement(page, 'status'))?.text;
      expect(statusText?.toLowerCase()).not.toContain('probe failed');
      expect(statusText?.toLowerCase()).not.toContain('shape');
    } finally {
      await context.close();
    }
  });
});
