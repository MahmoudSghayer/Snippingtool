// The published userscript is obfuscated (scripts/obfuscate.mjs, wired into
// scripts/build.mjs `buildUserscript`): a userscript is installed by hand, so
// its whole source sits in the user's script manager in the clear, and the
// owner does not want it read or copied wholesale. These tests pin the
// guarantees that obfuscation must not break:
//   - the code is actually obfuscated (readable identifiers gone, and the
//     obfuscator's hex-name signature present);
//   - the `==UserScript==` header and the .meta.js file stay plain text;
//   - the four template placeholders the API string-replaces at download time
//     survive byte for byte (reservedStrings);
//   - the embedded adapter is swapped in via its sentinel, which must be gone
//     from the shipped file;
//   - obfuscated code still runs;
//   - the Chrome extension (`ledger`) build is NOT obfuscated.
//
// The obfuscate.mjs unit checks run on small snippets (fast); the build-level
// checks run the real build script once each (slow, like
// userscript-template-version.test.ts).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADAPTER_SOURCE_SENTINEL,
  injectAdapterSource,
  obfuscateAdapterSource,
  obfuscateUserscriptCode,
} from '../../scripts/obfuscate.mjs';
import { TEMPLATE_PLACEHOLDERS } from '../../scripts/template-placeholders.mjs';

import { TEST_PUBLIC_KEY_PEM } from './license-test-keys.js';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The javascript-obfuscator hex identifier convention (`_0x1a2b`). esbuild /
 * Vite minification never produces it, so its presence means obfuscated and
 * its absence means not. */
const OBFUSCATOR_SIGNATURE = /_0x[0-9a-f]{4,}/;

describe('scripts/obfuscate.mjs', () => {
  it('renames identifiers and keeps the reserved placeholders verbatim, still runnable', () => {
    // Wrapped in an IIFE so the binding is function-scoped and gets renamed,
    // the way every name in the real (lib-mode IIFE) bundle is. renameGlobals
    // is off, so a top-level binding would be left alone.
    const source = `
      (function () {
        const unmistakableReadableName = (apiOrigin, licenseKey) => apiOrigin + '|' + licenseKey;
        globalThis.__obfTestResult = unmistakableReadableName(
          ${JSON.stringify(TEMPLATE_PLACEHOLDERS.apiOrigin)},
          ${JSON.stringify(TEMPLATE_PLACEHOLDERS.licensePublicKey)},
        );
      })();
    `;
    const out = obfuscateUserscriptCode(source);

    expect(out).not.toContain('unmistakableReadableName');
    expect(out).toMatch(OBFUSCATOR_SIGNATURE);
    // The API does a plain string replace on these, so they must survive.
    expect(out).toContain(TEMPLATE_PLACEHOLDERS.apiOrigin);
    expect(out).toContain(TEMPLATE_PLACEHOLDERS.licensePublicKey);

    const ctx: { globalThis?: unknown; __obfTestResult?: string } = {};
    ctx.globalThis = ctx;
    vm.runInNewContext(out, ctx);
    expect(ctx.__obfTestResult).toBe(
      `${TEMPLATE_PLACEHOLDERS.apiOrigin}|${TEMPLATE_PLACEHOLDERS.licensePublicKey}`,
    );
  });

  it('obfuscateAdapterSource produces runnable code without the readable source', () => {
    const source = `
      (function () {
        const secretAdapterInit = () => { const doubled = 21 * 2; return doubled; };
        globalThis.__adapterTest = secretAdapterInit();
      })();
    `;
    const out = obfuscateAdapterSource(source);

    expect(out).not.toContain('secretAdapterInit');
    expect(out).toMatch(OBFUSCATOR_SIGNATURE);

    const ctx: { globalThis?: unknown; __adapterTest?: number } = {};
    ctx.globalThis = ctx;
    vm.runInNewContext(out, ctx);
    expect(ctx.__adapterTest).toBe(42);
  });

  describe('injectAdapterSource', () => {
    it('swaps the single sentinel literal for the adapter, as a JS string', () => {
      const adapter = `(function(){ return "obfuscated adapter with a $dollar and 'quote'"; })();`;
      const main = `const a = 1; const src = "${ADAPTER_SOURCE_SENTINEL}"; use(src);`;
      const out = injectAdapterSource(main, adapter);

      expect(out).not.toContain(ADAPTER_SOURCE_SENTINEL);
      // The adapter is embedded as a valid JS string literal.
      expect(out).toContain(`const src = ${JSON.stringify(adapter)};`);
    });

    it('accepts a single-quoted sentinel (as the obfuscator may emit it)', () => {
      const out = injectAdapterSource(`var x='${ADAPTER_SOURCE_SENTINEL}';`, 'ADAPTER');
      expect(out).toBe(`var x=${JSON.stringify('ADAPTER')};`);
    });

    it('throws when the sentinel is missing or appears more than once', () => {
      expect(() => injectAdapterSource('const a = 1;', 'ADAPTER')).toThrow(/found 0/);
      expect(() =>
        injectAdapterSource(`"${ADAPTER_SOURCE_SENTINEL}" + "${ADAPTER_SOURCE_SENTINEL}"`, 'ADAPTER'),
      ).toThrow(/found 2/);
    });
  });
});

describe('built userscript --template (obfuscated)', () => {
  const version = '0.1.0.209901010000';
  let outDir: string;
  let script: string;
  let meta: string;
  let body: string;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'sl-userscript-obf-'));
    execFileSync(process.execPath, ['scripts/build.mjs', 'userscript', '--template'], {
      cwd: extensionRoot,
      env: { ...process.env, SL_EXT_OUT_DIR: outDir, USERSCRIPT_VERSION: version },
      stdio: 'pipe',
    });
    script = readFileSync(path.join(outDir, 'nova-trade.user.js'), 'utf8');
    meta = readFileSync(path.join(outDir, 'nova-trade.meta.js'), 'utf8');
    body = script.slice(script.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length);
  }, 180_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('keeps the ==UserScript== header and the .meta.js file plain text', () => {
    expect(script.startsWith('// ==UserScript==')).toBe(true);
    const end = script.indexOf('// ==/UserScript==');
    expect(end).toBeGreaterThan(0);
    const header = script.slice(0, end + '// ==/UserScript=='.length);
    // meta.js is exactly the header (plus a trailing newline), never obfuscated.
    expect(meta.trim()).toBe(header.trim());
    expect(header).not.toMatch(OBFUSCATOR_SIGNATURE);
    expect(meta).not.toMatch(OBFUSCATOR_SIGNATURE);
  });

  it('obfuscates the code below the header', () => {
    expect(body).toMatch(OBFUSCATOR_SIGNATURE);
    // Identifiers that are plainly readable in the unobfuscated bundle.
    for (const readable of ['handOffNonceWithinBundle', 'galleryListPrices', 'setFetchImpl']) {
      expect(body, `"${readable}" should be obfuscated away`).not.toContain(readable);
    }
  });

  it('keeps all four template placeholders verbatim for the API to replace', () => {
    for (const placeholder of Object.values(TEMPLATE_PLACEHOLDERS)) {
      expect(script, `placeholder ${placeholder} must survive obfuscation`).toContain(placeholder);
    }
  });

  it('swaps the embedded adapter in via its sentinel (none left in the file)', () => {
    expect(script).not.toContain(ADAPTER_SOURCE_SENTINEL);
  });
});

describe('built ledger (NOT obfuscated)', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'sl-ledger-obf-'));
    execFileSync(process.execPath, ['scripts/build.mjs', 'ledger'], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        SL_EXT_OUT_DIR: outDir,
        VITE_LICENSE_PUBLIC_KEY: TEST_PUBLIC_KEY_PEM.replace(/\n/g, '\\n'),
      },
      stdio: 'pipe',
    });
  }, 180_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('leaves the Chrome extension build un-obfuscated', () => {
    for (const file of ['adapter.js', 'content.js', 'background.js']) {
      const text = readFileSync(path.join(outDir, file), 'utf8');
      expect(text, `${file} must not be obfuscated`).not.toMatch(OBFUSCATOR_SIGNATURE);
    }
  });
});
