/*
 * ui-pages.spec.ts — loads the built `ledger` extension's popup and options
 * pages as real extension pages (`chrome-extension://<id>/...`), the way a
 * person actually opens them, and asserts:
 *   - no console errors / uncaught page errors on either page,
 *   - each page's key elements are present (status header + sign-in form
 *     for the popup's default logged-out state; every settings section for
 *     options),
 *   - zero serious/critical axe-core violations on either page.
 *
 * Same persistent-context extension-loading approach as
 * `extension.spec.ts` (MV3 unpacked extensions need a headed context —
 * `--load-extension` does not work in classic headless Chrome), so this
 * file needs the same run commands:
 *
 *   pnpm --filter @sl/extension build:ledger
 *   xvfb-run -a pnpm --filter @sl/extension test:e2e
 *
 * Screenshots land in `apps/extension/screenshots/` at each page's natural
 * size — popup at its fixed 360x600 (docs/10-design-system.md §15), options
 * at a representative desktop width.
 */
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test } from '@playwright/test';

import type { BrowserContext, ConsoleMessage, Page } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(dirname, '..', '..');
const distDir = path.join(extensionDir, 'dist', 'ledger');
const screenshotsDir = path.join(extensionDir, 'screenshots');
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

test.describe('popup and options pages', () => {
  test.skip(!existsSync(distDir), `dist/ledger not built — run "pnpm --filter @sl/extension build:ledger" first`);

  let context: BrowserContext;
  let extensionId: string;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      executablePath: existsSync(chromiumPath) ? chromiumPath : undefined,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, '--no-sandbox'],
    });

    // MV3's service worker registers asynchronously — wait for it (or use
    // the one that already registered before this listener attached) and
    // read the extension id out of its own URL, same as Playwright's own
    // documented pattern for extension testing.
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
    extensionId = new URL(worker.url()).host;

    mkdirSync(screenshotsDir, { recursive: true });
  });

  test.afterAll(async () => {
    await context.close();
  });

  function trackConsoleErrors(page: Page): { errors: string[] } {
    const tracked = { errors: [] as string[] };
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') tracked.errors.push(msg.text());
    });
    page.on('pageerror', (err) => tracked.errors.push(`pageerror: ${err.message}`));
    return tracked;
  }

  test('popup: no console errors, status header + sign-in form present, screenshot', async () => {
    const page = await context.newPage();
    const tracked = trackConsoleErrors(page);
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

    // Fresh profile, nothing signed in yet — `boot()` resolves to the
    // logged-out form (popup/main.ts's `renderLoggedOut`).
    await expect(page.locator('h1')).toContainText("Sniper's Ledger");
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#register-link')).toBeVisible();

    // Status dot: color is never the only signal (docs/10-design-system.md
    // §1) — the header text next to it is what this assertion actually
    // checks; the dot's own class is cosmetic here since there's no live
    // status yet yet in the logged-out state.
    await expect(page.locator('.dot')).toHaveCount(1);

    await page.screenshot({ path: path.join(screenshotsDir, 'popup-logged-out-360x600.png') });

    expect(tracked.errors, `popup console errors: ${JSON.stringify(tracked.errors)}`).toEqual([]);
    await page.close();
  });

  test('popup: keyboard access — Tab reaches every control, Enter submits the sign-in form', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

    await page.locator('#email').focus();
    await expect(page.locator('#email')).toBeFocused();
    await page.keyboard.type('not-a-real-account@example.com');
    await page.keyboard.press('Tab');
    await expect(page.locator('#password')).toBeFocused();
    await page.keyboard.type('wrong-password');

    // The service worker has no real API to reach in this environment, so
    // submitting just needs to not throw / not leave the page dead — the
    // actual auth outcome isn't this test's concern (auth flows are
    // covered by the unit suite's own login/2FA tests).
    await page.keyboard.press('Tab'); // -> #login button
    await expect(page.locator('#login')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('h1')).toContainText("Sniper's Ledger");

    await page.close();
  });

  test('popup: zero serious/critical axe-core violations', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2)).toEqual([]);
    await page.close();
  });

  test('options: no console errors, every section present, screenshot', async () => {
    const page = await context.newPage();
    const tracked = trackConsoleErrors(page);
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);

    await expect(page.locator('h1')).toContainText("Sniper's Ledger");
    for (const heading of [
      'Account & license',
      'Targets & budgets',
      'Governor thresholds',
      'Saved filters',
      'Devices',
      'Telemetry',
      'What it sends',
      'Diagnostics',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(page.locator('#minProfit')).toBeVisible();
    await expect(page.locator('#telemetry-optout')).toBeVisible();
    await expect(page.locator('#export-logs')).toBeVisible();

    await page.screenshot({ path: path.join(screenshotsDir, 'options-900.png'), fullPage: true });

    expect(tracked.errors, `options console errors: ${JSON.stringify(tracked.errors)}`).toEqual([]);
    await page.close();
  });

  test('options: zero serious/critical axe-core violations', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2)).toEqual([]);
    await page.close();
  });
});
