// Visual smoke test (PHASE 10 deliverable): visits every page at
// 390/768/1440px, screenshots each into apps/dashboard/screenshots/, and
// asserts zero console errors / page errors on every page at every
// breakpoint. Also captures a rough Web Vitals reading (FCP/LCP/CLS/TTFB)
// for /login and /dashboard at desktop width — printed to stdout and
// attached to the test report; docs/10-design-system.md records the
// numbers from the run this spec's header comment was last updated for.
//
// One continuous session (one login), for the same reason
// dashboard.spec.ts documents: the seeded admin's device limit is 1, so
// this deliberately reuses a single page/device fingerprint across every
// viewport rather than opening a fresh context per breakpoint.
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { loginAsAdmin } from './helpers/adminAuth.js';

import type { Page } from '@playwright/test';

interface Viewport {
  name: string;
  width: number;
  height: number;
}

const VIEWPORTS: Viewport[] = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
];

const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '..', 'screenshots');

interface VitalsResult {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number;
}

async function captureVitals(page: Page): Promise<VitalsResult> {
  return page.evaluate(
    () =>
      new Promise<VitalsResult>((resolve) => {
        const vitals: VitalsResult = { ttfb: null, fcp: null, lcp: null, cls: 0 };
        try {
          const nav = performance.getEntriesByType('navigation')[0] as
            PerformanceNavigationTiming | undefined;
          if (nav) vitals.ttfb = Math.round(nav.responseStart);
        } catch {
          // Navigation timing unavailable — leave ttfb null.
        }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.name === 'first-contentful-paint') vitals.fcp = Math.round(entry.startTime);
            }
          }).observe({ type: 'paint', buffered: true });
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const last = entries[entries.length - 1];
            if (last) vitals.lcp = Math.round(last.startTime);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & {
              hadRecentInput?: boolean;
              value?: number;
            })[]) {
              if (!entry.hadRecentInput && typeof entry.value === 'number')
                vitals.cls += entry.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {
          // Observer types unsupported — leave whichever fields null/0.
        }
        setTimeout(() => resolve(vitals), 1500);
      }),
  );
}

test.describe('visual smoke (screenshots + no console errors)', () => {
  test('every route at 390/768/1440px', async ({ page }, testInfo) => {
    // Defect #10 (docs/12-testing.md "Defects found"): this now covers the
    // 11 admin sub-pages docs/10-design-system.md §14 used to flag as
    // un-screenshotted (30 routes × 3 breakpoints, one continuous session,
    // plus Web Vitals captures) — comfortably past the suite-wide default
    // `timeout: 60_000` in playwright.config.ts, which is sized for the
    // smaller specs, not this one.
    test.setTimeout(180_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // Network-layer noise from *this sandboxed test environment's* outbound
    // HTTPS proxy (see the container's agent-proxy README) intercepting the
    // Google Fonts request with a CA Chromium doesn't trust
    // (`net::ERR_CERT_AUTHORITY_INVALID`) — not an app bug, and not
    // reproducible against a real deployment (Google Fonts serves fine
    // there; the font-family stack already falls back to system fonts
    // regardless). Everything else still fails the assertion below.
    const IGNORED_CONSOLE_PATTERNS = [/ERR_CERT_AUTHORITY_INVALID/];

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !IGNORED_CONSOLE_PATTERNS.some((p) => p.test(msg.text()))) {
        consoleErrors.push(`[console] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    async function visit(
      routePath: string,
      name: string,
      heading: string | RegExp,
      viewportName: string,
    ) {
      consoleErrors.length = 0;
      await page.goto(routePath);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
        timeout: 15_000,
      });
      // Let charts/animations/fonts settle before the screenshot.
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${name}-${viewportName}.png`),
        fullPage: true,
      });
      expect(
        consoleErrors,
        `console/page errors on ${routePath} @ ${viewportName}px:\n${consoleErrors.join('\n')}`,
      ).toEqual([]);
    }

    // --- Public pages, every breakpoint, before any auth state exists ---
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit('/login', 'login', 'Sign in', vp.name);
      await visit('/register', 'register', 'Create your account', vp.name);
    }

    // --- One login, then every authenticated page at every breakpoint ---
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsAdmin(page);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit('/dashboard', 'dashboard', 'Dashboard', vp.name);
      await visit('/analytics', 'analytics', 'Analytics', vp.name);
      await visit('/subscriptions', 'subscriptions', 'Subscription', vp.name);
      await visit('/settings', 'settings', 'Settings', vp.name);
      await visit('/admin', 'admin-overview', 'Overview', vp.name);
      await visit('/admin/audit', 'admin-audit', 'Audit log', vp.name);

      // The 11 admin sub-pages docs/10-design-system.md §14 flagged as a
      // screenshot-inventory gap (blocked at the time by the dashboard
      // e2e's default rate limits — see playwright.config.ts's webServer
      // env, RATE_LIMIT_GLOBAL_MAX/RATE_LIMIT_LOGIN_MAX, now raised for
      // exactly this run). `/admin` and `/admin/audit` above are the two
      // admin pages this spec already covered before that gap was closed.
      await visit('/admin/users', 'admin-users', 'Users', vp.name);
      await visit('/admin/profits', 'admin-profits', 'Profits', vp.name);
      await visit('/admin/activity', 'admin-activity', 'Activity', vp.name);
      await visit('/admin/system', 'admin-system', 'System', vp.name);
      await visit('/admin/subscriptions', 'admin-subscriptions', 'Subscriptions', vp.name);
      await visit('/admin/coupons', 'admin-coupons', 'Coupons', vp.name);
      await visit('/admin/plans', 'admin-plans', 'Plans', vp.name);
      await visit('/admin/flags', 'admin-flags', 'Flags', vp.name);
      await visit('/admin/bans', 'admin-bans', 'Bans', vp.name);
      await visit('/admin/feature-toggles', 'admin-feature-toggles', 'Feature toggles', vp.name);
      await visit('/admin/config', 'admin-config', 'System config', vp.name);

      await visit('/not-a-real-route', '404', 'Page not found', vp.name);
    }

    // --- Web Vitals: a rough reading for the two most-visited pages, at
    //     desktop width, against this dev build (not a production build —
    //     numbers here are directional, not a Lighthouse-grade budget). ---
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const dashboardVitals = await captureVitals(page);

    // eslint-disable-next-line no-console
    console.log('[web-vitals] /dashboard (dev server, 1440px):', JSON.stringify(dashboardVitals));
    await testInfo.attach('web-vitals-dashboard', {
      body: JSON.stringify(dashboardVitals, null, 2),
      contentType: 'application/json',
    });

    await page.context().clearCookies();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const loginVitals = await captureVitals(page);

    // eslint-disable-next-line no-console
    console.log('[web-vitals] /login (dev server, 1440px):', JSON.stringify(loginVitals));
    await testInfo.attach('web-vitals-login', {
      body: JSON.stringify(loginVitals, null, 2),
      contentType: 'application/json',
    });
  });
});
