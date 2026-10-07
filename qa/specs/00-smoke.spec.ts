// Smoke: confirms the target is reachable and the harness fixtures collect
// network + console data. Not an audit area on its own.
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';

test('landing page loads and serves the SPA shell', async ({ page, audit }) => {
  const resp = await page.goto('/');
  expect(resp?.status(), 'landing page HTTP status').toBeLessThan(400);
  await expect(page).toHaveTitle(/.+/);
  expect(audit.pageErrors, 'uncaught page errors on landing').toEqual([]);
});

test('public plans endpoint responds', async ({ request }) => {
  const r = await request.get(`${target.api}/api/v1/plans`);
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(Array.isArray(body.items)).toBeTruthy();
});
