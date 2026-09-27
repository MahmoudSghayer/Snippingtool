/*
 * assist-keys.ts — the assist hotkeys' page listener, and what the confirm
 * overlay says about a listing (P0 Task 13). Split out of content/index.ts
 * so "EA's own keys are never touched" is testable against a real DOM.
 */
import { cardLabel } from '../lib/card-label.js';
import { describeChord } from '../lib/hotkeys.js';
import { onTrusted } from '../ui/trusted-events.js';

import type { ScoredOpportunity } from '../engine/ranker.js';
import type { KeyChordEvent } from '../lib/hotkeys.js';
import type { ConfirmDetails, SelectionDetails } from '../ui/confirm-overlay.js';
import type { AssistHotkeys } from '@sl/shared';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return /^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable === true;
}

/** Listens for the assist chords on `doc`. Trusted key presses only: a page
 * script can dispatch a synthetic keydown on `document`
 * (ui/trusted-events.ts). `preventDefault` only when the engine acted on the
 * chord — never for EA's own keys — and never `stopPropagation`: EA's
 * handlers still see every key. Capture phase, so an EA handler that stops
 * propagation cannot hide a chord from it. */
export function installAssistHotkeys(doc: Document, getAssist: () => { handleKeydown(e: KeyChordEvent): boolean } | null): void {
  onTrusted(
    doc,
    'keydown',
    (e) => {
      if (isTypingTarget(e.target)) return;
      const assist = getAssist();
      if (assist?.handleKeydown(e)) e.preventDefault();
    },
    { capture: true },
  );
}

/** What the overlay shows for a listing: the card's name and rating from its
 * item data, else its resource id; the price; and the profit after EA's tax
 * at the recorded median (`netAtMedian`, the ranker's own number). */
export function confirmDetailsFor(candidate: ScoredOpportunity, hotkeys: AssistHotkeys): ConfirmDetails {
  return {
    title: cardLabel(candidate),
    price: candidate.price,
    expectedProfit: candidate.netAtMedian,
    confirmKey: describeChord(hotkeys.buy),
  };
}

/** The selection line after Alt+Up/Down: the listing, and where it is in
 * the current search's ranked list (`index` 0-based). */
export function selectionDetailsFor(candidate: ScoredOpportunity, index: number, count: number, hotkeys: AssistHotkeys): SelectionDetails {
  return { ...confirmDetailsFor(candidate, hotkeys), position: `${index + 1}/${count}` };
}
