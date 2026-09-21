// Regression coverage for docs/12-testing.md "Defects found" row #10: the
// content script's crash-recovery state (`Governor.serialize()`) used to be
// read from / written to `browser.storage.session` *from the content
// script*, which Chrome forbids (MV3's default `storage.session` access
// level is `TRUSTED_CONTEXTS` — background, popup, options only). The read
// threw "Access to storage is not allowed from this context", the content
// script's `main()` aborted before its engine bindings were initialised,
// and every later market observation crashed on them: no IndexedDB
// recording, no telemetry — the listable build's M1 core was dead.
//
// `background/governor.ts` now owns that key (`engine.stateSet` /
// `engine.stateGet`, backed by background's own `storage.session`), and
// `content/index.ts` never imports `lib/storage.ts` at all. These tests pin
// both halves: the relay round-trips byte-for-byte, and the content script
// stays storage-free (a static source check — the cross-app e2e journey
// `tests/e2e/specs/b-extension-bootstrap.spec.ts` covers the live path).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_GOVERNOR_SETTINGS, extBackgroundEngineStateSetPayloadSchema } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { handleEngineStateGet, handleEngineStateSet } from '../../src/background/governor.js';
import { Governor } from '../../src/engine/governor.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const contentSource = readFileSync(path.resolve(dirname, '../../src/content/index.ts'), 'utf8');

describe('background/governor.ts: content -> background crash-recovery state relay', () => {
  useRealChromeStorage();

  it('with nothing ever saved, get() returns null (fresh browsing session)', async () => {
    expect(await handleEngineStateGet()).toBeNull();
  });

  it('a real Governor.serialize() output round-trips byte-for-byte and validates against the message schema', async () => {
    const governor = new Governor(DEFAULT_GOVERNOR_SETTINGS, { now: () => 1_000_000 });
    governor.allow({ kind: 'search' }, 1_000_100);
    governor.setKillSwitch(true, 'server kill switch active at bootstrap');
    const state = governor.serialize();

    // The shared schema background validates every `engine.stateSet`
    // payload against must accept what the governor actually produces —
    // a drifted field would make background reject the save with
    // "Invalid message payload" and silently disable crash recovery.
    expect(extBackgroundEngineStateSetPayloadSchema.safeParse(state).success).toBe(true);

    expect(await handleEngineStateSet(state)).toEqual({ ok: true });
    const restored = await handleEngineStateGet();
    expect(restored).toEqual(state);

    // ...and what comes back hydrates into an equivalent governor.
    const hydrated = Governor.hydrate(DEFAULT_GOVERNOR_SETTINGS, restored!, { now: () => 1_000_200 });
    expect(hydrated.serialize()).toEqual(state);
    expect(hydrated.isKillSwitchActive()).toBe(true);
  });
});

describe('content/index.ts never touches extension storage directly', () => {
  it('does not import lib/storage.ts or reference browser.storage.session', () => {
    expect(contentSource).not.toMatch(/from '\.\.\/lib\/storage\.js'/);
    expect(contentSource).not.toMatch(/browser\.storage\.session/);
    expect(contentSource).not.toMatch(/\b(getSession|setSession)\(/);
  });

  it('declares the engine bindings before registering the adapter callbacks (no temporal dead zone on an early observation)', () => {
    const governorDecl = contentSource.indexOf('let governor: Governor | null = null;');
    const assistDecl = contentSource.indexOf('let assist: AssistEngine | null = null;');
    const onAuctions = contentSource.indexOf('adapter.onAuctions(');
    expect(governorDecl).toBeGreaterThan(-1);
    expect(assistDecl).toBeGreaterThan(-1);
    expect(onAuctions).toBeGreaterThan(-1);
    expect(governorDecl).toBeLessThan(onAuctions);
    expect(assistDecl).toBeLessThan(onAuctions);
  });
});
