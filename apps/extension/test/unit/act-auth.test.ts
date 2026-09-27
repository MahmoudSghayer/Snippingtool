// Unit coverage for lib/act-auth.ts (defect C10): the per-page-load secret
// that authenticates the act channel between content (ISOLATED world) and
// the MAIN-world adapter, and the handoff that gets it there without a page
// script ever being able to read it.

import { afterEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_ATTRIBUTE,
  canonicalActMessage,
  canonicalize,
  createActSigner,
  generateNonce,
  handOffNonce,
  readHandedOffNonce,
  takeHandedOffNonce,
} from '../../src/lib/act-auth.js';

afterEach(() => {
  document.documentElement.removeAttribute(HANDOFF_ATTRIBUTE);
});

describe('generateNonce', () => {
  it('is 32 random bytes, hex encoded, and different every call', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('canonicalize', () => {
  it('does not depend on key order and drops undefined values, like JSON', () => {
    expect(canonicalize({ b: 1, a: { d: undefined, c: [2, 'x'] } })).toBe(canonicalize({ a: { c: [2, 'x'] }, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('separates request and result messages, so one MAC cannot stand in for the other', () => {
    const data = { action: 'buy', requestId: 'r1' };
    expect(canonicalActMessage('act_request', data)).not.toBe(canonicalActMessage('action_result', data));
  });
});

describe('createActSigner', () => {
  it('refuses a malformed nonce', () => {
    expect(createActSigner('')).toBeNull();
    expect(createActSigner('not-hex')).toBeNull();
  });

  it('verifies its own MAC and rejects a tampered message or a different nonce', async () => {
    const nonce = generateNonce();
    const signer = createActSigner(nonce)!;
    const other = createActSigner(generateNonce())!;
    const message = canonicalActMessage('act_request', { action: 'buy', requestId: 'r1', tradeId: 't1', price: 1000 });
    const mac = await signer.sign(message);

    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(mac).not.toContain(nonce);
    expect(await signer.verify(message, mac)).toBe(true);
    expect(await signer.verify(message.replace('1000', '10'), mac)).toBe(false);
    expect(await other.verify(message, mac)).toBe(false);
    expect(await signer.verify(message, 'zz')).toBe(false);
  });
});

describe('nonce handoff', () => {
  it('content side: publishes the nonce to the DOM for the adapter and keeps a private copy', () => {
    const isolated: Record<string, unknown> = {};
    const nonce = handOffNonce(document, isolated);
    expect(document.documentElement.getAttribute(HANDOFF_ATTRIBUTE)).toBe(nonce);
    // Read once, then gone: nothing else in this world picks it up later.
    expect(readHandedOffNonce(isolated)).toBe(nonce);
    expect(readHandedOffNonce(isolated)).toBeNull();
  });

  it('adapter side: takes the nonce and removes every DOM trace of it', () => {
    const nonce = handOffNonce(document, {});
    let taken: string | null = null;
    takeHandedOffNonce(document, (n) => (taken = n));
    expect(taken).toBe(nonce);
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);
  });

  it('adapter side: still gets the nonce if its script happened to run before the handoff', async () => {
    let taken: string | null = null;
    takeHandedOffNonce(document, (n) => (taken = n));
    expect(taken).toBeNull();
    const nonce = handOffNonce(document, {});
    await Promise.resolve(); // MutationObserver callbacks are microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(taken).toBe(nonce);
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);

    // One-shot: a later value (e.g. planted by a page script) is not taken.
    document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, 'f'.repeat(64));
    await new Promise((r) => setTimeout(r, 0));
    expect(taken).toBe(nonce);
  });

  it('adapter side: stops waiting once the page starts being parsed, so a page script cannot supply the nonce', async () => {
    let taken: string | null = null;
    takeHandedOffNonce(document, (n) => (taken = n));
    document.documentElement.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 0));
    document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, 'e'.repeat(64));
    await new Promise((r) => setTimeout(r, 0));
    expect(taken).toBeNull();
  });
});
