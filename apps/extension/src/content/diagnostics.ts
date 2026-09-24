/*
 * diagnostics.ts — the content-script end of the options page's "Copy
 * diagnostics" (docs/06-extension.md §4, day-one checklist).
 *
 * The options page asks an open EA tab (`diagnostics.collect`); this asks
 * the MAIN-world adapter for its report over the authenticated act channel
 * (content/adapter-client.ts, lib/act-auth.ts) and hands it back. Nothing a
 * page script can trigger: runtime messages reach a content script only
 * from the extension itself, and the sender's id is checked anyway. The
 * adapter side is read-only.
 *
 * Chrome-free (the sender and runtime id are passed in), so the userscript
 * build can reuse it with its own trigger.
 */
import { extContentDiagnosticsRequestSchema, type ExtContentDiagnosticsResponse } from '@sl/shared';

import type { AdapterClient } from './adapter-client.js';

/** A `runtime.onMessage` listener body: a promise of the reply for a
 * `diagnostics.collect` from this extension, `undefined` for anything else
 * (so other listeners still get their messages). */
export function createDiagnosticsResponder(
  adapter: Pick<AdapterClient, 'diagnostics'>,
  runtimeId: string,
): (message: unknown, sender: { id?: string }) => Promise<ExtContentDiagnosticsResponse> | undefined {
  return (message, sender) => {
    if (!extContentDiagnosticsRequestSchema.safeParse(message).success) return undefined;
    if (!sender || sender.id !== runtimeId) return undefined;
    return adapter.diagnostics().then(
      (outcome): ExtContentDiagnosticsResponse =>
        outcome.ok && outcome.diagnostics
          ? { ok: true, diagnostics: outcome.diagnostics }
          : { ok: false, error: outcome.error ?? 'the adapter returned no diagnostics' },
      (err: unknown): ExtContentDiagnosticsResponse => ({ ok: false, error: String(err) }),
    );
  };
}
