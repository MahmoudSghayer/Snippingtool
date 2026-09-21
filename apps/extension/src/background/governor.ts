/*
 * background/governor.ts — caches the latest live risk-budget snapshot the
 * content script pushes, so the popup can render the real segmented gauge
 * instead of the static "open the panel" card (docs/10-design-system.md
 * §15's "Known gap", docs/12-testing.md "Defects found").
 *
 * The governor itself only ever runs inside the content script attached to
 * the active EA tab (docs/01-architecture.md, "safety governor") — this
 * file never recomputes or reconstructs a risk number, it only relays and
 * caches the exact object `engine/governor.ts`'s own `snapshot()` produced,
 * on the same UI tick that already updates the in-page panel
 * (`content/index.ts`'s risk-meter interval). If no EA tab has pushed a
 * snapshot recently (no tab open, or the cached one is stale), the popup
 * gets `null` and falls back to its honest static message — never a
 * fabricated or reconstructed number.
 */
import { getSession, setSession } from '../lib/storage.js';

import type { ExtEngineStateSetPayload, ExtGovernorSnapshotPushPayload } from '@sl/shared';


const SNAPSHOT_KEY = 'sl.governor.snapshot.v1';

// content/index.ts pushes on a 3s tick (RISK_UI_TICK_MS) — anything older
// than a few missed ticks means the tab that was reporting it is gone
// (closed, navigated away, or the content script itself torn down), so the
// popup should show its honest fallback rather than a frozen, increasingly
// wrong number.
const STALE_AFTER_MS = 10_000;

interface StoredSnapshot {
  snapshot: ExtGovernorSnapshotPushPayload;
  capturedAt: number;
}

export async function handleGovernorSnapshotPush(payload: ExtGovernorSnapshotPushPayload): Promise<{ ok: true }> {
  const stored: StoredSnapshot = { snapshot: payload, capturedAt: Date.now() };
  await setSession(SNAPSHOT_KEY, stored);
  return { ok: true };
}

/** Returns the most recently pushed snapshot, or `null` if none has ever
 * been pushed (no EA tab this session) or the cached one is stale (the tab
 * that was pushing it is no longer doing so). Never fabricates a value. */
export async function handleGovernorSnapshotGet(): Promise<ExtGovernorSnapshotPushPayload | null> {
  const stored = await getSession<StoredSnapshot | null>(SNAPSHOT_KEY, null);
  if (!stored) return null;
  if (Date.now() - stored.capturedAt > STALE_AFTER_MS) return null;
  return stored.snapshot;
}

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
// trips through background like the risk snapshot above. The access level
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
