// Build-level check for defect C10: the listable `ledger` build's MAIN-world
// adapter must not let a page script reach buyNow. The older build check
// (test/e2e/extension.spec.ts) only greps dist/ledger for the string
// "autobuyer", which says nothing about what adapter.js can actually *do*.
// This one builds the real `ledger` target with the real build script, loads
// the emitted adapter.js into a fresh page, and drives its act channel the
// way a hostile page script would — then, as a positive control, the way
// content.js does, to prove the harness can reach the capability at all.
//
// `ledger` keeps the act surface (assist mode's human-confirmed buys go
// through it — engine/assist.ts), so the assertion is "cannot be triggered
// without the nonce", not "absent".

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce } from '../../src/lib/act-auth.js';

import { TEST_PUBLIC_KEY_PEM } from './license-test-keys.js';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let outDir: string;
let adapterSource: string;
let manifest: { content_scripts: { js: string[]; world?: string; run_at: string }[] };

beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 'sl-ledger-build-'));
  execFileSync(process.execPath, ['scripts/build.mjs', 'ledger'], {
    cwd: extensionRoot,
    // The test licence key, in the `\n`-escaped PEM form `.env` files use
    // for ENTITLEMENT_PUBLIC_KEY: build.mjs refuses a release build without
    // a usable key (build-license-key.test.ts).
    env: { ...process.env, SL_EXT_OUT_DIR: outDir, VITE_LICENSE_PUBLIC_KEY: TEST_PUBLIC_KEY_PEM.replace(/\n/g, '\\n') },
    stdio: 'pipe',
  });
  adapterSource = readFileSync(path.join(outDir, 'adapter.js'), 'utf8');
  manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

interface Page {
  dom: JSDOM;
  buyNow: ReturnType<typeof vi.fn>;
  posted: { kind: string; data: Record<string, unknown> }[];
  search: ReturnType<typeof vi.fn>;
  deliver(message: unknown): void;
}

/** A fresh EA-like page with the built adapter.js injected at
 * document_start, after the ISOLATED-world handoff put `nonce` on the DOM. */
function loadPage(nonce: string | null): Page {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.ea.com/en/ultimate-team/web-app/index.html',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const winProps = win as unknown as Record<string, unknown>;
  // jsdom lacks WebCrypto/TextEncoder on its window; Chrome has both.
  Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
  if (!winProps.TextEncoder) Object.defineProperty(win, 'TextEncoder', { value: TextEncoder, configurable: true });

  const buyNow = vi.fn(async () => ({ success: true }));
  const search = vi.fn(async () => ({
    auctionInfo: [{ tradeId: 777, buyNowPrice: 50_000, startingBid: 150, currentBid: 0, offers: 0, expires: 3600, itemData: { resourceId: 9, assetId: 9, rating: 90 } }],
  }));
  winProps.services = { Item: { repository: { search } }, Transfer: { repository: { buyNow, bid: vi.fn() } } };

  const posted: Page['posted'] = [];
  win.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { channel?: string; kind: string; data: Record<string, unknown> } | null;
    if (m?.channel === ADAPTER_CHANNEL) posted.push(m);
  });

  if (nonce) win.document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, nonce);
  // Evaluating our own freshly built adapter.js inside an isolated jsdom
  // page is the point of this test (it is how Chrome runs a MAIN-world
  // content script); nothing untrusted is evaluated.
  win.eval(adapterSource);

  return {
    dom,
    buyNow,
    search,
    posted,
    deliver: (message) => win.dispatchEvent(new win.MessageEvent('message', { data: message, source: win })),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('dist/ledger contents', () => {
  // The same rule as test/e2e/extension.spec.ts's "ledger build contents"
  // suite, run here too so a unit run catches it: the listable build must
  // not mention the autobuyer anywhere — not even as a feature-key string.
  it('never mentions "autobuyer", in any file', () => {
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const full = path.join(file.parentPath, file.name);
      expect(readFileSync(full, 'utf8').toLowerCase().includes('autobuyer'), `${path.relative(outDir, full)} mentions autobuyer`).toBe(false);
    }
  });

  // The listable build has no Sniping Bot: no page, no engine, and none of
  // its background handlers (background/index.ts registers them only when
  // VITE_AUTOMATION is '1'; the message names live in @sl/shared's
  // automation-messages.ts, which only automation code imports).
  it('carries none of the Sniping Bot: no page, no loop, no bot/catalog handlers', () => {
    const forbidden = [
      'Sniping Bot',
      'runCycle',
      'catalog.save',
      'catalog.get',
      'cards.names',
      'bot.settingsGet',
      'bot.settingsSet',
      'bot.usageGet',
      'bot.usageSet',
      'bot.budgetGet',
      'bot.budgetSet',
    ];
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    for (const file of files) {
      const full = path.join(file.parentPath, file.name);
      const text = readFileSync(full, 'utf8');
      for (const word of forbidden) expect(text.includes(word), `${path.relative(outDir, full)} contains "${word}"`).toBe(false);
    }
  });
});

describe('dist/ledger manifest', () => {
  it('runs the ISOLATED-world nonce handoff at document_start, ahead of the MAIN-world adapter', () => {
    const scripts = manifest.content_scripts;
    const handoff = scripts.findIndex((s) => s.js.includes('handoff.js'));
    const adapter = scripts.findIndex((s) => s.js.includes('adapter.js'));
    expect(handoff).toBeGreaterThanOrEqual(0);
    expect(handoff).toBeLessThan(adapter);
    expect(scripts[handoff]).toMatchObject({ world: 'ISOLATED', run_at: 'document_start' });
    expect(scripts[adapter]).toMatchObject({ world: 'MAIN', run_at: 'document_start' });
  });
});

describe('dist/ledger/adapter.js act channel', () => {
  it('leaves no trace of the nonce in the DOM', () => {
    const page = loadPage(generateNonce());
    expect(page.dom.window.document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);
    expect(page.dom.window.document.documentElement.outerHTML).not.toContain(HANDOFF_ATTRIBUTE);
  });

  it('a page script cannot trigger buyNow: unsigned, forged and replayed-looking requests are ignored', async () => {
    const page = loadPage(generateNonce());
    const buy = { action: 'buy', requestId: 'page-1', tradeId: '777', price: 50_000 };
    page.deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: buy });
    page.deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { ...buy, requestId: 'page-2' }, mac: '0'.repeat(64) });
    const forger = createActSigner(generateNonce())!;
    const forged = { ...buy, requestId: 'page-3' };
    page.deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: forged, mac: await forger.sign(canonicalActMessage('act_request', forged)) });
    await settle();

    expect(page.buyNow).not.toHaveBeenCalled();
    expect(page.posted.filter((m) => m.kind === 'action_result')).toHaveLength(0);
  });

  it('positive control: the content-side signer can drive a search and a matching buy', async () => {
    const nonce = generateNonce();
    const page = loadPage(nonce);
    const signer = createActSigner(nonce)!;
    const send = async (data: Record<string, unknown>) =>
      page.deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data, mac: await signer.sign(canonicalActMessage('act_request', data)) });

    await send({ action: 'search', requestId: 'c-1', filter: {} });
    await vi.waitFor(() => expect(page.posted.some((m) => m.kind === 'action_result' && m.data.requestId === 'c-1')).toBe(true));

    await send({ action: 'buy', requestId: 'c-2', tradeId: '777', price: 1 });
    await vi.waitFor(() => expect(page.posted.find((m) => m.kind === 'action_result' && m.data.requestId === 'c-2')?.data).toMatchObject({ ok: false, error: 'price_mismatch' }));
    expect(page.buyNow).not.toHaveBeenCalled();

    await send({ action: 'buy', requestId: 'c-3', tradeId: '777', price: 50_000 });
    await vi.waitFor(() => expect(page.buyNow).toHaveBeenCalledWith('777'));
  });

  it('with no nonce handed off, tells content it cannot act instead of leaving it to time out', async () => {
    const page = loadPage(null);
    const signer = createActSigner(generateNonce())!;
    const data = { action: 'buy', requestId: 'nokey-1', tradeId: '777', price: 50_000 };
    page.posted.length = 0;
    page.deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data, mac: await signer.sign(canonicalActMessage('act_request', data)) });
    await vi.waitFor(() => expect(page.posted.find((m) => m.kind === 'probe')?.data).toMatchObject({ actReady: false }));
    expect(page.buyNow).not.toHaveBeenCalled();
    expect(page.search).not.toHaveBeenCalled();
  });
});
