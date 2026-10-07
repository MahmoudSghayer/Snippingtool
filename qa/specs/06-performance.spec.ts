// Passive performance measurement (no load generation): navigation timing +
// paint/LCP for key pages, transferred JS weight, and API latency observed
// during a page load. Thresholds are advisory — breaches are recorded as
// findings rather than hard failures, so one slow run on a shared box does
// not red the whole audit.
import { test, expect } from '../helpers/fixtures.ts';
import { target } from '../helpers/targets.ts';

interface Metrics {
  ttfb: number;
  domContentLoaded: number;
  load: number;
  lcp: number;
  jsBytes: number;
}

async function measure(page: import('@playwright/test').Page, path: string): Promise<Metrics> {
  await page.goto(path, { waitUntil: 'load' });
  // Give LCP a moment to settle.
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as PerformanceEntry[];
    const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : 0;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const jsBytes = res
      .filter((r) => r.name.endsWith('.js') || r.initiatorType === 'script')
      .reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
    return {
      ttfb: nav ? Math.round(nav.responseStart) : 0,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
      load: nav ? Math.round(nav.loadEventEnd) : 0,
      lcp: Math.round(lcp),
      jsBytes,
    };
  });
}

const BUDGET = { lcp: 4000, load: 6000, jsKB: 1500 };

for (const path of ['/', '/login', '/account']) {
  test(`performance: ${path}`, async ({ page, audit }) => {
    // /account needs auth; skip if not logged in context — measured anonymously
    // it just lands on /login, which is still a useful number.
    const m = await measure(page, path);
    // eslint-disable-next-line no-console
    console.log(`[perf] ${path} ttfb=${m.ttfb}ms dcl=${m.domContentLoaded}ms load=${m.load}ms lcp=${m.lcp}ms js=${Math.round(m.jsBytes / 1024)}KB`);
    const apiStats = audit.apiStats('/api/');
    if (apiStats.count) console.log(`[perf] ${path} api calls=${apiStats.count} avg=${apiStats.avg}ms max=${apiStats.max}ms`);

    if (m.lcp > BUDGET.lcp || m.load > BUDGET.load || m.jsBytes / 1024 > BUDGET.jsKB) {
      await audit.report({
        id: `perf${path.replaceAll('/', '-') || '-home'}`,
        title: `Performance budget exceeded on ${path}`,
        severity: 'low',
        category: 'performance',
        location: path,
        steps: `Load ${path} and read Navigation Timing + resource sizes.`,
        expected: `LCP<=${BUDGET.lcp}ms, load<=${BUDGET.load}ms, JS<=${BUDGET.jsKB}KB.`,
        actual: `LCP=${m.lcp}ms load=${m.load}ms JS=${Math.round(m.jsBytes / 1024)}KB`,
        suggestedFix: 'Code-split heavy routes, defer non-critical JS, check image/LCP element.',
      });
    }
    expect(m.load, `page ${path} should eventually load`).toBeGreaterThan(0);
  });
}
