// Mobile / responsive: on a phone viewport (project `mobile`, Pixel 7) the
// key pages must not overflow horizontally and primary controls must be
// reachable. Horizontal overflow is the most common responsive defect, so it
// is checked explicitly.
import { test, expect } from '../helpers/fixtures.ts';

const PAGES = ['/', '/login', '/register', '/terms', '/refund-policy'];

for (const path of PAGES) {
  test(`no horizontal overflow on mobile: ${path}`, async ({ page, audit }) => {
    const resp = await page.goto(path);
    expect(resp?.status() ?? 200, `${path} status`).toBeLessThan(400);
    await page.waitForTimeout(300);
    const { scrollW, clientW } = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    // Allow a 2px rounding slack.
    if (scrollW > clientW + 2) {
      await audit.report({
        id: `mobile-overflow${path.replaceAll('/', '-') || '-home'}`,
        title: `Horizontal overflow on mobile: ${path}`,
        severity: 'low',
        category: 'ux',
        location: path,
        steps: `Open ${path} at 412px width (Pixel 7).`,
        expected: 'Content fits the viewport width; no horizontal scroll.',
        actual: `scrollWidth=${scrollW}px > clientWidth=${clientW}px`,
        suggestedFix: 'Find the element wider than the viewport (often a fixed-width container or unwrapped text).',
      });
    }
    expect(scrollW, `${path} horizontal overflow`).toBeLessThanOrEqual(clientW + 2);
  });
}
