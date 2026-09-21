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

import type { ExtGovernorSnapshotPushPayload } from '@sl/shared';


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
