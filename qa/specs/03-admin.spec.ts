// Admin console: each page loads for a super-admin, renders its shell, and
// produces no uncaught errors. One admin login for the whole file (shared
// context, serial) — avoids re-hitting the login limiter and the 5-minute
// admin-access-token / refresh-rotation interplay that breaks per-test
// session reuse. Mutations are NOT performed here; destructive/global admin
// actions are covered by the repo's own suites on the local stack.
import { chromium as pwChromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';
import { loginAdmin } from '../helpers/auth.ts';
import { record, SCREENS_DIR } from '../helpers/audit.ts';
import fs from 'node:fs';
import path from 'node:path';

test.describe.configure({ mode: 'serial' });

const PAGES = [
  '/admin', '/admin/users', '/admin/profits', '/admin/activity', '/admin/system',
  '/admin/audit', '/admin/subscriptions', '/admin/payments', '/admin/coupons',
  '/admin/plans', '/admin/flags', '/admin/bans', '/admin/feature-toggles', '/admin/config',
];

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 NovaTradeQA/1.0';

test.describe('Admin console', () => {
  let ctx: BrowserContext;
  let page: Page;
  let loggedIn = false;

  test.beforeAll(async () => {
    if (!target.admin) return;
    const browser = await pwChromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    ctx = await browser.newContext({ baseURL: target.web, userAgent: UA, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    const r = await loginAdmin(page, target.admin!);
    loggedIn = r.ok;
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  for (const p of PAGES) {
    test(`admin page ${p} loads`, async () => {
      test.skip(!target.admin, 'no admin creds');
      expect(loggedIn, 'admin login (beforeAll) succeeded').toBeTruthy();
      const errors: string[] = [];
      const onErr = (e: Error) => errors.push(String(e));
      page.on('pageerror', onErr);
      const resp = await page.goto(p, { waitUntil: 'domcontentloaded' });
      expect(resp?.status() ?? 200, `${p} HTTP`).toBeLessThan(400);
      await expect(page.getByRole('link', { name: /go to overview/i }).first(), `${p} admin shell`).toBeVisible({ timeout: 10_000 });
      const notFound = await page.getByText(/page not found|404/i).count();
      expect(notFound, `${p} should not be 404 for super-admin`).toBe(0);
      page.off('pageerror', onErr);
      if (errors.length) {
        fs.mkdirSync(SCREENS_DIR, { recursive: true });
        const shot = `admin${p.replaceAll('/', '-')}.png`;
        await page.screenshot({ path: path.join(SCREENS_DIR, shot) }).catch(() => {});
        record({
          id: `admin-errors${p.replaceAll('/', '-')}`,
          title: `Uncaught JS errors on ${p}`,
          severity: 'medium', category: 'functional', location: p,
          steps: `Log in as super-admin and open ${p}.`,
          expected: 'No uncaught errors.', actual: errors.join(' | ').slice(0, 300),
          screenshot: path.join('screens', shot), suggestedFix: 'Investigate the console trace for this page.',
          target: process.env.QA_TARGET ?? 'local',
        });
      }
    });
  }

  test('command palette opens with Cmd/Ctrl+K', async () => {
    test.skip(!target.admin, 'no admin creds');
    expect(loggedIn).toBeTruthy();
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+KeyK');
    const palette = page.getByRole('combobox').or(page.getByRole('dialog'));
    const opened = await palette.first().isVisible({ timeout: 2000 }).catch(() => false);
    if (!opened) {
      record({
        id: 'ux-command-palette',
        title: 'Command palette did not open via Cmd/Ctrl+K',
        severity: 'low', category: 'ux', location: 'apps/dashboard admin shell (useCommandPaletteShortcut)',
        steps: 'As admin, focus the page and press Ctrl/Cmd+K.',
        expected: 'The command palette dialog opens.',
        actual: 'No palette dialog/combobox appeared within 2s.',
        suggestedFix: 'Verify the global keydown listener is attached in the admin shell and not swallowed.',
        target: process.env.QA_TARGET ?? 'local',
      });
    }
    expect(opened, 'command palette opens on keyboard shortcut').toBeTruthy();
  });
});
