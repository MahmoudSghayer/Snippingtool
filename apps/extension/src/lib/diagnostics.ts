/*
 * diagnostics.ts — assembles the report the options page's "Copy
 * diagnostics" button puts on the clipboard (docs/06-extension.md §4,
 * day-one checklist): the extension's version and build target, plus the
 * MAIN-world adapter's own report from an open EA tab (probe result,
 * selected shape, `window.services` key names, the last market response's
 * keys and types, its last 50 log lines).
 *
 * No tokens, emails or coin balances: the adapter report carries key names
 * and types rather than values, and every string in it is scrubbed once
 * more here (lib/redact.ts) before it can reach a clipboard or a bug report.
 *
 * Tab access is passed in (`queryTabs`/`sendToTab`), so this stays testable
 * and free of chrome APIs.
 */
import { extContentDiagnosticsResponseSchema, type AdapterDiagnostics, type LifecycleStats } from '@sl/shared';

import { scrubText } from './redact.js';

export const DIAGNOSTICS_REPORT_KIND = 'nova-trade-diagnostics';

export interface DiagnosticsReport {
  kind: typeof DIAGNOSTICS_REPORT_KIND;
  formatVersion: 1;
  generatedAt: string;
  extension: { version: string; buildTarget: string };
  /** The adapter's report from the first EA tab that gave one, or null. */
  adapter: AdapterDiagnostics | null;
  /** Why `adapter` is null. */
  adapterError?: string;
  /** The trade lifecycle's counters (background/lifecycle.ts): buys that
   * carried no item id and so cannot be followed, items followed, sales
   * reported. Null when background did not answer. */
  lifecycle?: LifecycleStats | null;
}

export interface DiagnosticsDeps {
  version: string;
  buildTarget: string;
  queryTabs: () => Promise<Array<{ id?: number; active?: boolean }>>;
  sendToTab: (tabId: number, message: unknown) => Promise<unknown>;
  lifecycleStats?: () => Promise<LifecycleStats | null>;
  now?: () => number;
}

/** Every string inside `value`, scrubbed; object keys too. */
function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[scrubText(key)] = scrubDeep(v);
    return out as T;
  }
  return value;
}

export async function collectDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  const report: DiagnosticsReport = {
    kind: DIAGNOSTICS_REPORT_KIND,
    formatVersion: 1,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    extension: { version: deps.version, buildTarget: deps.buildTarget },
    adapter: null,
  };
  if (deps.lifecycleStats) {
    try {
      const stats = await deps.lifecycleStats();
      report.lifecycle = stats
        ? { buysWithoutItemId: Number(stats.buysWithoutItemId) || 0, followed: Number(stats.followed) || 0, salesReported: Number(stats.salesReported) || 0 }
        : null;
    } catch {
      report.lifecycle = null;
    }
  }

  let tabs: Array<{ id?: number; active?: boolean }>;
  try {
    tabs = await deps.queryTabs();
  } catch (err) {
    report.adapterError = `could not list EA tabs: ${scrubText(String(err))}`;
    return report;
  }
  // The tab the user is looking at first; it is the one they mean.
  const ordered = tabs.filter((t) => t.id != null).sort((a, b) => Number(!!b.active) - Number(!!a.active));
  if (ordered.length === 0) {
    report.adapterError = 'no EA web app tab is open — open the web app, then copy diagnostics again';
    return report;
  }

  const errors: string[] = [];
  for (const tab of ordered) {
    let answer: unknown;
    try {
      answer = await deps.sendToTab(tab.id!, { type: 'diagnostics.collect' });
    } catch (err) {
      errors.push(`tab ${tab.id}: ${String(err)}`);
      continue;
    }
    const parsed = extContentDiagnosticsResponseSchema.safeParse(answer);
    if (!parsed.success) {
      errors.push(`tab ${tab.id}: ${answer === undefined ? 'no answer (content script not loaded?)' : 'malformed answer'}`);
      continue;
    }
    if (!parsed.data.ok) {
      errors.push(`tab ${tab.id}: ${parsed.data.error}`);
      continue;
    }
    report.adapter = scrubDeep(parsed.data.diagnostics);
    return report;
  }
  report.adapterError = scrubText(errors.join('; '));
  return report;
}
