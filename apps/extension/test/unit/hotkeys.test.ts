// Assist hotkeys are modifier chords (P0 Task 13, item 1): a key EA's own UI
// uses on its own (Enter, Space, the arrows) is never one of them.
import { DEFAULT_ASSIST_HOTKEYS } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { chordOf, describeChord, matchHotkey } from '../../src/lib/hotkeys.js';

const key = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey', boolean>> = {}, k = '') => ({
  code,
  key: k,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('chordOf', () => {
  it('names a modifier chord by its modifiers and physical key', () => {
    expect(chordOf(key('KeyB', { altKey: true }, '∫'))).toBe('Alt+KeyB'); // Option+B on a Mac
    expect(chordOf(key('ArrowUp', { altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+ArrowUp');
    expect(chordOf(key('KeyN', { shiftKey: true, altKey: true }))).toBe('Alt+Shift+KeyN');
  });

  it('is null for EA’s own keys, Shift-only chords and a lone modifier', () => {
    expect(chordOf(key('Enter', {}, 'Enter'))).toBeNull();
    expect(chordOf(key('Space', {}, ' '))).toBeNull();
    expect(chordOf(key('ArrowUp', {}, 'ArrowUp'))).toBeNull();
    expect(chordOf(key('KeyB', { shiftKey: true }, 'B'))).toBeNull();
    expect(chordOf(key('AltLeft', { altKey: true }, 'Alt'))).toBeNull();
  });
});

describe('matchHotkey', () => {
  it('finds the action a chord is bound to, whatever order the stored modifiers are in', () => {
    expect(matchHotkey(key('KeyB', { altKey: true }), DEFAULT_ASSIST_HOTKEYS)).toBe('buy');
    expect(matchHotkey(key('ArrowDown', { altKey: true }), DEFAULT_ASSIST_HOTKEYS)).toBe('selectDown');
    expect(matchHotkey(key('KeyN', { altKey: true, shiftKey: true }), { ...DEFAULT_ASSIST_HOTKEYS, prevFilter: 'Shift+Alt+KeyN' })).toBe('prevFilter');
    expect(matchHotkey(key('Enter'), DEFAULT_ASSIST_HOTKEYS)).toBeNull();
    expect(matchHotkey(key('KeyB', { ctrlKey: true }), DEFAULT_ASSIST_HOTKEYS)).toBeNull();
  });
});

describe('describeChord', () => {
  it('reads like the key caps', () => {
    expect(describeChord('Alt+KeyB')).toBe('Alt+B');
    expect(describeChord('Alt+ArrowUp')).toBe('Alt+↑');
    expect(describeChord('Ctrl+Alt+Digit1')).toBe('Ctrl+Alt+1');
  });
});
