// obfuscate.mjs — obfuscation for the userscript target only (build.mjs,
// `buildUserscript`). The `ledger` and `ledger-auto` Chrome extension builds
// never go through here: they ship through a store / self-hosted update
// server and stay as Vite emits them.
//
// A userscript is installed by hand into Tampermonkey, so its whole source
// sits in the user's script manager in the clear. The owner distributes it
// per licensed user and does not want it read or copied wholesale, so the
// published file is obfuscated. This is identifier renaming plus string
// hiding, nothing that changes behaviour — see docs/06-extension.md.
//
// Deliberately light (see BASE): none of the transforms that would slow the
// trading hot path or risk breaking EA's page are enabled. The header and
// the .meta.js file are never passed here; build.mjs obfuscates only the
// code below the header.
import JavaScriptObfuscator from 'javascript-obfuscator';

import { TEMPLATE_PLACEHOLDERS } from './template-placeholders.mjs';

// Embedded in place of the real adapter source while the main bundle is
// obfuscated, then swapped for the already-obfuscated adapter
// (injectAdapterSource). The adapter is obfuscated on its own first; keeping
// the real thing out of the main bundle's obfuscation is what stops its
// string array being base64-encoded a second time.
export const ADAPTER_SOURCE_SENTINEL = 'NOVA_ADAPTER_SOURCE_PLACEHOLDER';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The API fills these four placeholders in with a plain string replace at
// download time (apps/api/src/lib/extension-download.ts), so each must
// survive obfuscation byte for byte, in the body as well as the header.
// reservedStrings keeps any string literal that matches one of these
// patterns from being renamed, moved into the string array or encoded. The
// sentinel is reserved the same way so injectAdapterSource can find it. A
// partial match is enough, so the apiOrigin host inside the full origin
// literal is covered too.
const RESERVED_STRINGS = [
  ...Object.values(TEMPLATE_PLACEHOLDERS).map(escapeRegExp),
  escapeRegExp(ADAPTER_SOURCE_SENTINEL),
];

// Shared base, kept deliberately light. No controlFlowFlattening,
// deadCodeInjection, debugProtection, selfDefending or renameGlobals: each
// of those either slows the hot path (a buy must go out in a few ms) or
// risks breaking code that runs inside EA's own page. So this only renames
// identifiers to short hex names and hides string literals. target
// 'browser' so no Node-only runtime helpers are emitted.
const BASE = {
  compact: true,
  target: 'browser',
  identifierNamesGenerator: 'hexadecimal',
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  renameGlobals: false,
  sourceMap: false,
  reservedStrings: RESERVED_STRINGS,
};

/**
 * Obfuscate the main userscript bundle (header excluded). `keepVerbatim` are
 * extra literal strings to leave untouched on top of the placeholders — the
 * build passes the compiled-in @version, which the page shows and which the
 * publish tooling greps out of the file, so it must stay readable in the body
 * as well as the header.
 */
export function obfuscateUserscriptCode(code, keepVerbatim = []) {
  return JavaScriptObfuscator.obfuscate(code, {
    ...BASE,
    stringArray: true,
    // No base64 encoding and no call-wrapper transform. The bundle is one
    // file — our src/** and bundled libraries (Zod above all) together — and
    // the obfuscator cannot be pointed at our code alone. With base64
    // encoding on, its atob string-array decoder ran inside Zod's hot loops:
    // a Chrome trace showed it at ~44% of a 2.4s freeze every time the panel
    // validated the 100k-player catalog. Plain strings in the array keep our
    // code hidden (identifiers are still renamed to hex) without a per-access
    // decode, and dropping the calls transform removes the extra accessor
    // indirection from those same loops. See docs/06-extension.md.
    stringArrayEncoding: [],
    stringArrayCallsTransform: false,
    stringArrayThreshold: 0.75,
    reservedStrings: [...RESERVED_STRINGS, ...keepVerbatim.map(escapeRegExp)],
  }).getObfuscatedCode();
}

// The adapter runs in EA's own page (MAIN world) and relies on built-in
// references it captures at load (Reflect.apply/construct, lib it pins at
// document_start). Keep its options lighter than the main bundle's — string
// array indirection with no base64 encoding, so no atob decode wrapper is
// added around it — to stay well clear of that capturing logic and keep the
// injected script small.
export function obfuscateAdapterSource(code) {
  return JavaScriptObfuscator.obfuscate(code, {
    ...BASE,
    stringArray: true,
    stringArrayEncoding: [],
    stringArrayThreshold: 0.75,
  }).getObfuscatedCode();
}

/**
 * Swap the reserved sentinel string literal in the obfuscated main bundle
 * for the already-obfuscated adapter, as a JS string literal. Exactly one
 * sentinel must be present (the one the adapter-source virtual module
 * emitted); anything else means the build changed shape and should fail
 * loudly rather than ship an empty adapter.
 */
export function injectAdapterSource(mainCode, adapterSource) {
  const pattern = new RegExp(`(['"])${escapeRegExp(ADAPTER_SOURCE_SENTINEL)}\\1`, 'g');
  const matches = mainCode.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `expected exactly one embedded adapter-source sentinel, found ${matches?.length ?? 0}`,
    );
  }
  // A function replacement so $ in the obfuscated adapter is not treated as
  // a replacement pattern.
  return mainCode.replace(pattern, () => JSON.stringify(adapterSource));
}
