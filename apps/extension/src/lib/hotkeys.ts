/*
 * hotkeys.ts — the assist hotkeys are modifier chords (P0 Task 13): Alt+B
 * buys, Alt+Up/Down move the selection. The old bindings were bare keys
 * (Enter, Space, the arrows) captured on the whole page, so every Enter a
 * trader pressed in EA's own UI was also a buy key, and was swallowed with
 * `preventDefault`. A chord here always holds Alt, Ctrl or Meta, and is
 * named by `KeyboardEvent.code` (the physical key), not `key`: Option+B
 * types `∫` on a Mac, and `KeyB` is the B key on every layout. The chord
 * format and its validation are `assistHotkeysSchema` in @sl/shared.
 */
import { HOTKEY_MODIFIERS, type AssistHotkeys } from '@sl/shared';

export interface KeyChordEvent {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

/** Codes of the modifier keys themselves: pressing Alt alone is no chord. */
const MODIFIER_CODE = /^(Alt|Control|Shift|Meta|OS)(Left|Right)?$/;

/** The chord a key press makes, modifiers in canonical order (Ctrl, Alt,
 * Shift, Meta), or null when it is not a chord (no Alt, Ctrl or Meta held,
 * or only a modifier pressed). */
export function chordOf(e: KeyChordEvent): string | null {
  if (!e.altKey && !e.ctrlKey && !e.metaKey) return null;
  if (!e.code || MODIFIER_CODE.test(e.code)) return null;
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey };
  const mods = HOTKEY_MODIFIERS.filter((m) => held[m]);
  return [...mods, e.code].join('+');
}

/** A stored chord with its modifiers put in canonical order. */
function normalise(chord: string): string {
  const parts = chord.split('+');
  const code = parts[parts.length - 1] ?? '';
  const mods = new Set(parts.slice(0, -1));
  return [...HOTKEY_MODIFIERS.filter((m) => mods.has(m)), code].join('+');
}

/** Which assist action a key press is bound to, if any. */
export function matchHotkey(e: KeyChordEvent, hotkeys: AssistHotkeys): keyof AssistHotkeys | null {
  const chord = chordOf(e);
  if (!chord) return null;
  for (const [action, bound] of Object.entries(hotkeys) as [keyof AssistHotkeys, string][]) {
    if (normalise(bound) === chord) return action;
  }
  return null;
}

const CODE_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** A chord as the key caps read: `Alt+KeyB` -> `Alt+B`, `Alt+ArrowUp` -> `Alt+↑`. */
export function describeChord(chord: string): string {
  const parts = chord.split('+');
  const code = parts.pop() ?? '';
  const label = CODE_LABELS[code] ?? code.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=[0-9]$)/, '');
  return [...parts, label].join('+');
}
