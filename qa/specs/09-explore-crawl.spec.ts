// Exploratory crawl: a real browser walks the app like a QA engineer poking
// around — follows in-app links reachable from the landing, account and admin
// surfaces, and flags dead ends, console errors, failed requests, broken
// images and pages that render empty. Findings are recorded to the audit log.
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';
import { loginAdmin } from '../helpers/auth.ts';
import { record } from '../helpers/audit.ts';

test.describe.configure({ mode: 'serial' });

test('crawl: admin surface for dead links, console errors, broken images', async ({ page }) => {
  test.skip(!target.admin, 'no admin creds');
  const r = await loginAdmin(page, target.admin!);
  expect(r.ok, 'admin login').toBeTruthy();

  const origin = new URL(target.web).origin;
  const visited = new Set<string>();
  const queue = ['/admin'];
  const consoleErrors: Record<string, string[]> = {};
  const failed: Record<string, string[]> = {};
  const brokenImages: Record<string, number> = {};
  const deadEnds: string[] = [];

  let current = '/admin';
  page.on('console', (m) => {
    if (m.type() === 'error') (consoleErrors[current] ??= []).push(m.text().slice(0, 160));
  });
  page.on('requestfailed', (rq) => {
    (failed[current] ??= []).push(`${rq.method()} ${rq.url().split(origin).join('')} ${rq.failure()?.errorText ?? ''}`);
  });

  while (queue.length && visited.size < 25) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    current = path;
    const resp = await page.goto(path, { waitUntil: 'networkidle' }).catch(() => null);
    const status = resp?.status() ?? 0;
    if (status >= 400) deadEnds.push(`${path} → HTTP ${status}`);

    // Broken images.
    const broken = await page.evaluate(() =>
      Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
    );
    if (broken) brokenImages[path] = broken;

    // Empty render (shell with no main content).
    const mainText = (await page.locator('main').first().textContent().catch(() => '')) ?? '';
    if (status < 400 && mainText.trim().length < 2) deadEnds.push(`${path} → empty <main>`);

    // Enqueue same-origin in-app links.
    const links = await page.evaluate((o) =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h.startsWith(o))
        .map((h) => new URL(h).pathname), origin);
    for (const l of links) if (!visited.has(l) && l.startsWith('/admin')) queue.push(l);
  }

  const pagesWithConsoleErrors = Object.entries(consoleErrors).filter(([, v]) => v.length);
  const pagesWithFailed = Object.entries(failed).filter(([, v]) => v.length);

  // eslint-disable-next-line no-console
  console.log(`[crawl] visited ${visited.size} admin pages`);
  console.log(`[crawl] dead ends: ${deadEnds.length ? deadEnds.join(' | ') : 'none'}`);
  console.log(`[crawl] broken images: ${Object.keys(brokenImages).length ? JSON.stringify(brokenImages) : 'none'}`);
  console.log(`[crawl] console errors on: ${pagesWithConsoleErrors.map(([p]) => p).join(', ') || 'none'}`);
  console.log(`[crawl] failed requests on: ${pagesWithFailed.map(([p]) => p).join(', ') || 'none'}`);

  if (deadEnds.length) {
    record({ id: 'crawl-dead-ends', title: 'Dead ends / empty pages found while crawling the admin surface',
      severity: 'medium', category: 'functional', location: 'admin crawl',
      steps: 'Log in as admin and follow in-app links from /admin.', expected: 'Every reachable admin link renders content.',
      actual: deadEnds.join(' | ').slice(0, 400), suggestedFix: 'Fix the routes/links listed.',
      target: process.env.QA_TARGET ?? 'local' });
  }
  for (const [p, errs] of pagesWithConsoleErrors) {
    record({ id: `crawl-console${p.replaceAll('/', '-')}`, title: `Console errors on ${p}`,
      severity: 'low', category: 'functional', location: p, steps: `Open ${p} as admin.`,
      expected: 'No console errors.', actual: errs.join(' | ').slice(0, 300),
      suggestedFix: 'Investigate the console errors.', target: process.env.QA_TARGET ?? 'local' });
  }

  // The crawl is a probe, not a hard gate: assert only that it visited pages
  // and found no hard dead ends (empty/4xx admin routes).
  expect(visited.size, 'crawl reached admin pages').toBeGreaterThan(3);
  expect(deadEnds, 'no dead ends in the admin surface').toEqual([]);
});
