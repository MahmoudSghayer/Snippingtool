// axe-core accessibility checks (PHASE 10 deliverable 4): Login, Dashboard
// and Admin Overview must carry zero serious/critical violations. Runs
// against the real apps/api + seeded dev Postgres/Redis, same as
// dashboard.spec.ts (see that file's header for the infra this expects).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { loginAsAdmin } from './helpers/adminAuth.js';

/** Fails the test with a readable dump of every serious/critical
 * violation (rule id, impact, the offending selector(s)) rather than a
 * bare boolean — axe's own assertion message is otherwise too terse to
 * act on from CI output. */
function expectNoSeriousOrCriticalViolations(
  results: Awaited<ReturnType<AxeBuilder['analyze']>>,
): void {
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  if (bad.length > 0) {
    const details = bad
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      )
      .join('\n');
    throw new Error(`${bad.length} serious/critical axe violation(s):\n${details}`);
  }
  expect(bad).toHaveLength(0);
}

test.describe('accessibility (axe-core, zero serious/critical)', () => {
  test('login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('body').analyze();
    expectNoSeriousOrCriticalViolations(results);
  });

  test('dashboard and admin overview (post-login)', async ({ page }) => {
    await loginAsAdmin(page);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const dashboardResults = await new AxeBuilder({ page }).include('body').analyze();
    expectNoSeriousOrCriticalViolations(dashboardResults);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Online users')).toBeVisible();
    const adminResults = await new AxeBuilder({ page }).include('body').analyze();
    expectNoSeriousOrCriticalViolations(adminResults);
  });
});
