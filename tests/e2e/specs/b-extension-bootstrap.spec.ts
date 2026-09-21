// Journey (b): extension (this suite's own build — see build-extension.mjs
// for why it's a separate build from apps/extension/dist/ledger) loaded
// against the mock EA page -> popup login against the *real* API (built
// with EXTENSION_IDS set to this exact unpacked install's id, see
// playwright.config.ts) -> bootstrap ok -> a passive observation is
// recorded and its activity event reaches the API (rows in
// user_activity/search_activity) -> admin flips the kill switch -> the
// panel (the popup — see this file's own comment further down for why the
// popup, not the shadow-DOM page panel, is what this journey asserts on)
// reports halted.
//
// Reuses apps/extension/test/fixtures/mock-ea-app (owned by the extension
// agent) read-only, the same way apps/extension/test/e2e/extension.spec.ts
// does — never duplicated into tests/fixtures (see tests/fixtures/README.md).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test } from '@playwright/test';

import { EXTENSION_OUT_DIR } from '../build-extension.mjs';
import { bearer, createAdminSession, registerAndVerifyOnly, TEST_PASSWORD } from '../helpers/auth.js';
import { connect, deleteUsersByEmailPrefix } from '../helpers/db.js';
import { API_ORIGIN, EXTENSION_ID } from '../playwright.config.js';

import type { BrowserContext } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..', '..');
const fixtureDir = path.join(repoRoot, 'apps', 'extension', 'test', 'fixtures', 'mock-ea-app');
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const EA_PAGE_URL = 'https://www.ea.com/en/ultimate-team/web-app/index.html';

const EXT_EMAIL = `e2e-journey-b-${Date.now()}@example.com`;
const ADMIN_EMAIL = `e2e-journey-b-admin-${Date.now()}@example.com`;

test.afterAll(async () => {
  const db = connect();
  try {
    await deleteUsersByEmailPrefix(db, 'e2e-journey-b-');
  } finally {
    await db.end({ timeout: 5 });
  }
});

async function routeMockEa(context: BrowserContext): Promise<void> {
  await context.route('https://www.ea.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/transfermarket')) {
      const payload = await import('../../../apps/extension/test/fixtures/mock-ea-app/payloads.js');
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
}

test('extension: loads against the mock EA page, popup login against the real API, observation + telemetry reach it, kill switch halts the panel', async ({ request }) => {
  test.skip(!existsSync(EXTENSION_OUT_DIR), 'extension not built — prepare.mjs should have built it; see build-extension.mjs');

  const targetUser = await test.step('a verified (but not yet logged in anywhere) user exists to log into the extension with', () => registerAndVerifyOnly(API_ORIGIN, EXT_EMAIL));
  const admin = await test.step('an admin exists to flip the kill switch later', () => createAdminSession(API_ORIGIN, ADMIN_EMAIL, 'journey-b-admin'));

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    executablePath: existsSync(chromiumPath) ? chromiumPath : undefined,
    args: [`--disable-extensions-except=${EXTENSION_OUT_DIR}`, `--load-extension=${EXTENSION_OUT_DIR}`, '--no-sandbox'],
  });

  try {
    // Sanity: the id playwright.config.ts baked into apps/api's
    // EXTENSION_IDS really is this install's id (see
    // helpers/extension-id.mjs's header for why it's computed rather than
    // read off the running context up front).
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    expect(new URL(sw.url()).hostname).toBe(EXTENSION_ID);

    await routeMockEa(context);
    const eaPage = await context.newPage();
    await eaPage.goto(EA_PAGE_URL, { waitUntil: 'load' });

    await test.step('the panel appears against the mock EA page and the bundle probe reports ok', async () => {
      const host = eaPage.locator('#ledger-root');
      await expect(host).toHaveCount(1, { timeout: 15_000 });
      const dotClass = await host.evaluate((el) => (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.getElementById('dot')?.className);
      expect(dotClass).not.toContain('warn');

      // The mock page's own passive search happens shortly after load
      // (mock-service-layer.js), same as
      // apps/extension/test/e2e/extension.spec.ts's own wait — without
      // this, the later "flush and check search_activity" step can race
      // ahead of the observation itself ever having enqueued anything
      // (reproduced while authoring this spec: the flush step consistently
      // saw `sent: 0` because there was nothing queued yet, not because
      // flushing itself was broken).
      await expect
        .poll(async () => host.evaluate((el) => (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.getElementById('total')?.textContent), { timeout: 15_000 })
        .not.toBe('—');
    });

    const popup = await context.newPage();
    await test.step('popup login against the real API', async () => {
      // Vite's multi-page build preserves each HTML entry's source path
      // under outDir (`src/popup/index.html`, not flattened to
      // `popup/index.html`) — matches manifest.json's own
      // `action.default_popup` (generate-manifest.mjs), confirmed against
      // the real build while authoring this spec.
      await popup.goto(`chrome-extension://${EXTENSION_ID}/src/popup/index.html`);
      await popup.locator('#email').fill(EXT_EMAIL);
      await popup.locator('#password').fill(TEST_PASSWORD);
      await popup.locator('#login').click();
      // renderLoggedIn() (popup/main.ts) shows the plan row once
      // license.bootstrap resolves against the real API. `getByText('Plan',
      // { exact: false })` alone is ambiguous — Playwright's substring text
      // match is case-insensitive, so it matches both the "Plan" row label
      // *and* "No active plan" (reproduced while authoring this spec:
      // "strict mode violation ... resolved to 2 elements"); asserting on
      // the value text alone is unambiguous and is the thing that actually
      // proves bootstrap resolved.
      await expect(popup.getByText('No active plan')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('bootstrap registered the device server-side', async () => {
      const db = connect();
      try {
        const rows = await db<{ id: string }[]>`select id from devices where user_id = ${targetUser.userId} and status = 'active'`;
        expect(rows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await db.end({ timeout: 5 });
      }
    });

    await test.step("the mock page's passive search was recorded and, once flushed, reaches the API (search_activity)", async () => {
      // content/index.ts enqueues a 'search' activity event as soon as the
      // mock service layer's own passive search response is observed (the
      // same event the panel's "Auctions recorded" counter reacts to,
      // already proven non-zero by apps/extension/test/e2e/extension.spec.ts —
      // this step is the cross-app half: does it reach apps/api). Flushed
      // on a 2-minute chrome.alarms tick in real usage
      // (background/telemetry.ts) — forced immediately here via the same
      // 'telemetry.flush' message the alarm itself sends, from an extension
      // page context (popup), rather than waiting out the real interval.
      await expect
        .poll(
          async () => {
            const result = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'telemetry.flush' }))) as { ok: boolean; data?: { ok: boolean; sent: number } };
            return result?.data?.sent ?? 0;
          },
          { timeout: 20_000, message: 'waiting for the queued search activity event to exist and flush' },
        )
        .toBeGreaterThan(0);

      const db = connect();
      try {
        const rows = await db<{ id: string; user_id: string }[]>`select id, user_id from search_activity where user_id = ${targetUser.userId}`;
        expect(rows.length, 'expected the flushed search event to land in search_activity').toBeGreaterThanOrEqual(1);
      } finally {
        await db.end({ timeout: 5 });
      }
    });

    await test.step('admin flips the kill switch -> the panel (popup) reports halted on its next bootstrap', async () => {
      try {
        const patch = await request.patch(`${API_ORIGIN}/api/v1/admin/toggles/kill_switch`, { headers: bearer(admin.accessToken), data: { enabled: true } });
        expect(patch.status(), await patch.text()).toBe(200);

        await popup.reload();
        await expect(popup.getByText('Kill switch active', { exact: false })).toBeVisible({ timeout: 15_000 });

        // Also verify the underlying contract directly (not just the UI
        // string): a fresh heartbeat's own response says the same thing.
        const heartbeat = (await popup.evaluate(() =>
          chrome.runtime.sendMessage({ type: 'license.heartbeat', payload: { engineState: 'idle' } }),
        )) as { ok: boolean; data?: { killSwitchActive: boolean } };
        expect(heartbeat.data?.killSwitchActive).toBe(true);
      } finally {
        // Cleanup: kill_switch is a single global toggle shared by the whole
        // (dev) database — leaving it 'enabled' would halt every other
        // extension instance/test that reads it after this spec runs.
        const reset = await request.patch(`${API_ORIGIN}/api/v1/admin/toggles/kill_switch`, { headers: bearer(admin.accessToken), data: { enabled: false } });
        expect(reset.status(), 'failed to reset kill_switch back to disabled — see this step\'s try block').toBe(200);
      }
    });
  } finally {
    await context.close();
  }
});
