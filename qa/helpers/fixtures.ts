// Playwright fixtures used across the audit specs:
//  - `audit`:   a per-test collector of console errors, failed requests and
//               network timings, plus a `report()` helper that appends a
//               finding (with an auto-captured screenshot) to the audit log.
//  - `net`:     the list of API requests observed, for latency / status / authz checks.
// The base `page` is wired to a pinned User-Agent at the context level in
// playwright.config.ts (refresh tokens are bound to the UA family).
import { test as base, expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { record, SCREENS_DIR, type Finding, type Severity } from './audit.ts';

export interface NetEntry {
  method: string;
  url: string;
  status: number;
  ms: number;
  ok: boolean;
}

export interface AuditCtx {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  net: NetEntry[];
  /** Append a finding; captures a screenshot of the current page. */
  report(f: Omit<Finding, 'screenshot' | 'target'> & { page?: Page }): Promise<void>;
  /** Latency summary for API calls matching a path substring. */
  apiStats(pathIncludes: string): { count: number; max: number; avg: number };
}

let seq = 0;

export const test = base.extend<{ audit: AuditCtx }>({
  audit: async ({ page }, use, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const net: NetEntry[] = [];
    const started = new Map<Request, number>();

    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('request', (r) => started.set(r, Date.now()));
    page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) => {
      const req = r.request();
      const t0 = started.get(req);
      const url = r.url();
      if (url.includes('/api/') || url.includes('/ws') || url.includes('/health') || url.includes('/metrics')) {
        net.push({ method: req.method(), url, status: r.status(), ms: t0 ? Date.now() - t0 : -1, ok: r.ok() });
      }
    });

    const ctx: AuditCtx = {
      consoleErrors,
      pageErrors,
      failedRequests,
      net,
      async report(f) {
        const p = f.page ?? page;
        let shot: string | undefined;
        try {
          const name = `${String(++seq).padStart(3, '0')}-${f.id}.png`;
          const file = path.join(SCREENS_DIR, name);
          fs.mkdirSync(SCREENS_DIR, { recursive: true });
          await p.screenshot({ path: file, fullPage: false }).catch(() => {});
          if (fs.existsSync(file)) shot = path.join('screens', name);
        } catch {
          /* screenshots are best-effort */
        }
        record({
          id: f.id,
          title: f.title,
          severity: f.severity,
          category: f.category,
          location: f.location,
          steps: f.steps,
          expected: f.expected,
          actual: f.actual,
          suggestedFix: f.suggestedFix,
          screenshot: shot,
          target: process.env.QA_TARGET ?? 'local',
        });
        testInfo.annotations.push({ type: f.severity, description: `${f.id}: ${f.title}` });
      },
      apiStats(pathIncludes) {
        const xs = net.filter((n) => n.url.includes(pathIncludes)).map((n) => n.ms).filter((n) => n >= 0);
        if (!xs.length) return { count: 0, max: 0, avg: 0 };
        return { count: xs.length, max: Math.max(...xs), avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) };
      },
    };

    await use(ctx);
  },
});

export { expect };
export type { Page, Severity };
