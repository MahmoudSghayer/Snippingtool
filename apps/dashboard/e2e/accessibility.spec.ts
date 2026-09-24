// axe-core accessibility checks (PHASE 10 deliverable 4): Login, My account
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

  test('admin overview and my account (post-login)', async ({ page }) => {
    // Signing in as an admin lands on /admin (the admin overview).
    await loginAsAdmin(page);
    await expect(page.getByText('Online users')).toBeVisible();
    const adminResults = await new AxeBuilder({ page }).include('body').analyze();
    expectNoSeriousOrCriticalViolations(adminResults);

    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
    const accountResults = await new AxeBuilder({ page }).include('body').analyze();
    expectNoSeriousOrCriticalViolations(accountResults);
  });
});
