// entries.mjs — what an extension build emits, in one place. Imported by
// scripts/build.mjs and by tests/e2e/build-extension.mjs (the e2e suite's own
// build of the `ledger` target), so the two cannot drift apart again: the
// e2e build once lacked handoff.js, which the manifest lists, and Chrome
// refuses to load an extension whose content script is missing.
//
// Order matters for the library-mode builds: the first one empties outDir.

/** Content scripts: each its own self-contained IIFE (MV3 content scripts
 * cannot be ES modules). `globalName` is the IIFE's global. */
export const LIB_ENTRIES = Object.freeze([
  // MAIN world, document_start: the adapter over EA's own service layer.
  { entry: 'src/main/adapter.ts', fileName: 'adapter.js', globalName: 'SLAdapter' },
  // ISOLATED world, document_start: hands the act-channel nonce to
  // adapter.js (lib/act-auth.ts).
  { entry: 'src/content/handoff.ts', fileName: 'handoff.js', globalName: 'SLHandoff' },
  // ISOLATED world, document_idle: the content script proper.
  { entry: 'src/content/index.ts', fileName: 'content.js', globalName: 'SLContent' },
]);

/** The ES-module group: background service worker, popup and options page
 * (these may share chunks). Emitted as `<name>.js`. */
export const ES_GROUP_INPUTS = Object.freeze({
  background: 'src/background/index.ts',
  popup: 'src/popup/index.html',
  options: 'src/options/index.html',
});
