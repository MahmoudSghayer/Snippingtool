/*
 * background/governor.ts — the governor's crash-recovery state relay. The
 * governor itself only ever runs inside the content script attached to the
 * active EA tab (docs/01-architecture.md, "safety governor"); this file only
 * stores what it serializes.
 */
import { getSession, setSession } from '../lib/storage.js';

import type { ExtEngineStateSetPayload } from '@sl/shared';

// ---- crash-recovery state relay (docs/06-extension.md §7) -----------------
//
// Defect #10 (docs/12-testing.md "Defects found"): `content/index.ts` used
// to read/write this key in `browser.storage.session` *itself* — but MV3
// content scripts are not a trusted context for `storage.session` (its
// default access level is `TRUSTED_CONTEXTS`), so the very first read threw
// "Access to storage is not allowed from this context", the content
// script's `main()` aborted before the engine bindings were initialised,
// and every later market observation crashed on them (no recording, no
// telemetry — the listable build's M1 core was dead). The state now round-
// trips through background instead. The access level
// is deliberately *not* widened with `chrome.storage.session.setAccessLevel`:
// `storage.session` also holds the access token (docs/09-security.md
// "Token storage"), and a content script sharing a page with EA's own code
// must never be able to read it.
const ENGINE_STATE_KEY = 'sl.engine.state.v1';

export async function handleEngineStateSet(payload: ExtEngineStateSetPayload): Promise<{ ok: true }> {
  await setSession(ENGINE_STATE_KEY, payload);
  return { ok: true };
}

/** The last persisted `Governor.serialize()` state for this browsing
 * session, or `null` when none was ever saved (fresh session / browser
 * restart — `storage.session` clears with the browser, which is exactly
 * the "survives a reload, not forever" semantics §7 wants). */
export async function handleEngineStateGet(): Promise<ExtEngineStateSetPayload | null> {
  return getSession<ExtEngineStateSetPayload | null>(ENGINE_STATE_KEY, null);
}
