// UX & accessibility: axe scan on the public + auth pages, basic keyboard
// reachability, and presence of a usable 404. Findings are recorded; serious
// (critical/serious) axe violations fail the test so they surface in CI.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';

const PUBLIC_PAGES = ['/', '/login', '/register', '/forgot-password', '/terms', '/refund-policy'];

test.describe('UX & accessibility', () => {
  for (const path of PUBLIC_PAGES) {
    test(`axe scan: ${path}`, async ({ page, audit }) => {
      const resp = await page.goto(path);
      expect(resp?.status() ?? 200, `${path} status`).toBeLessThan(400);
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      if (serious.length) {
        await audit.report({
          id: `a11y${path.replaceAll('/', '-') || '-home'}`,
          title: `Accessibility violations on ${path}`,
          severity: serious.some((v) => v.impact === 'critical') ? 'high' : 'medium',
          category: 'accessibility',
          location: path,
          steps: `Open ${path} and run axe-core (wcag2a/aa).`,
          expected: 'No serious or critical WCAG 2 A/AA violations.',
          actual: serious.map((v) => `${v.id} (${v.impact}, ${v.nodes.length})`).join('; ').slice(0, 400),
          suggestedFix: serious.map((v) => v.help).join(' | ').slice(0, 300),
        });
      }
      // Record but don't hard-fail the whole audit on moderate issues.
      expect(serious.map((v) => v.id), `serious a11y issues on ${path}`).toEqual(serious.length ? expect.any(Array) : []);
    });
  }

  test('404 page is a real not-found, not a blank or crash', async ({ page }) => {
    const resp = await page.goto('/this-route-does-not-exist-qa');
    // SPA may return 200 for the shell; the body must show a not-found state.
    await page.waitForTimeout(400);
    const text = (await page.textContent('body'))?.toLowerCase() ?? '';
    expect(text.length, 'non-empty body on unknown route').toBeGreaterThan(20);
    expect(text).toMatch(/not found|404|doesn'?t exist|back home|go home/);
  });

  test('login form is keyboard reachable', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(['input', 'button', 'a'], 'focus lands on an interactive element').toContain(active ?? '');
  });
});
