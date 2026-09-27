#!/usr/bin/env node
// build.mjs — builds one target (`ledger`, `ledger-auto` or `userscript`,
// each `ledger-auto` and `userscript` also as a `--template` for the API's
// downloads) of the extension. What each target emits is listed in
// ./entries.mjs. Plain Vite (programmatic API), not `@crxjs/vite-plugin`: crxjs
// pins itself to Vite <= 5's plugin hook signatures and does not yet support
// Vite 6 (the version this repo's other packages already standardise on —
// see packages/config), so this repo uses plain multi-entry Vite builds plus
// this hand-written manifest generator instead (docs/06-extension.md,
// "Build targets" documents this decision).
//
// Three separate `vite.build()` calls per target, not one multi-entry build,
// because content scripts must ship as a single self-contained file with no
// code-splitting (MV3 does not support ES module content scripts) while the
// service worker + popup are ordinary ES modules that *can*
// share chunks:
//   1. adapter.js   — MAIN world,  library-mode IIFE, single entry
//   1b. handoff.js  — ISOLATED world, document_start, IIFE: hands the
//                     act-channel nonce to adapter.js (lib/act-auth.ts)
//   2. content.js   — ISOLATED world, library-mode IIFE, single entry
//   3. background.js + src/popup/index.html — ES
//
// `virtual:autobuyer-loader` is aliased per target to
// `engine/autobuyer-loader.ledger.ts` (no reference to `engine/autobuyer.ts`
// at all) or `.auto.ts` (real loader) — this alias, not a runtime flag, is
// what guarantees `engine/autobuyer.ts` never enters the `ledger` build's
// module graph. See docs/06-extension.md for the full explanation.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { ES_GROUP_INPUTS, LIB_ENTRIES, USERSCRIPT_ENTRIES } from './entries.mjs';
import { buildManifest } from './generate-manifest.mjs';
import { licenseKeyProblem } from './license-key.mjs';
import { TEMPLATE_PLACEHOLDERS } from './template-placeholders.mjs';
import { buildUserscriptHeader } from './userscript-header.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const target = process.argv[2];
const watch = process.argv.includes('--watch');
if (target !== 'ledger' && target !== 'ledger-auto' && target !== 'userscript') {
  console.error(`usage: node scripts/build.mjs <ledger|ledger-auto|userscript> [--watch] [--template]`);
  process.exit(1);
}
if (target === 'userscript' && watch) {
  console.error('--watch is not supported for the userscript target');
  process.exit(1);
}
// The userscript carries the autobuyer, like `ledger-auto` (it is never
// listed in a store). Every automated action still goes through the governor.
const automation = target === 'ledger-auto' || target === 'userscript';
// `--template` builds what the API serves as downloads: the `ledger-auto`
// zip's files, or the userscript. The API origin, dashboard origin and
// license public key are placeholders that the API fills in with its own
// configuration when it serves the download
// (apps/api/src/lib/extension-download.ts), so one image serves a correct
// build on any deployment. The userscript template also carries a
// placeholder download token in its @downloadURL/@updateURL, which the API
// replaces with the user's signed token. The placeholders are exported from
// ./template-placeholders.mjs, which the API imports too.
const template = process.argv.includes('--template');
if (template && target === 'ledger') {
  console.error('--template only applies to ledger-auto and userscript');
  process.exit(1);
}

// Tampermonkey only installs an update when `@version` goes up, so every
// hand-published userscript build gets its own: the package version plus a
// UTC build stamp (0.1.0.202609230830 > 0.1.0.202609221900).
// USERSCRIPT_VERSION pins it. The API-served template uses the extension
// version as is, so the userscript updates when the extension does.
// The same version is compiled in, so the page can show which one runs.
const version =
  target === 'userscript' && !template
    ? process.env.USERSCRIPT_VERSION ||
      `${pkg.version}.${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`
    : pkg.version;

// SL_EXT_OUT_DIR lets a test build into a scratch directory
// (test/unit/ledger-build-adapter.test.ts) without racing a real build of
// dist/<target>.
const outDir = process.env.SL_EXT_OUT_DIR
  ? path.resolve(process.env.SL_EXT_OUT_DIR)
  : path.join(root, 'dist', template ? `${target}-template` : target);

const env = {
  VITE_AUTOMATION: automation ? '1' : '0',
  VITE_BUILD_TARGET: target,
  VITE_API_ORIGIN: template ? TEMPLATE_PLACEHOLDERS.apiOrigin : process.env.VITE_API_ORIGIN || 'https://api.snipersledger.app',
  // Where the companion site lives, for the install-time welcome tab
  // (background/welcome.ts). Same override story as VITE_API_ORIGIN:
  // set it in the environment to point a build at a self-hosted stack.
  VITE_DASHBOARD_ORIGIN: template ? TEMPLATE_PLACEHOLDERS.dashboardOrigin : process.env.VITE_DASHBOARD_ORIGIN || 'https://snipersledger.app',
  // An unpacked (downloaded) extension ignores update_url, so the template
  // doesn't declare one.
  VITE_UPDATE_URL: target === 'ledger-auto' && !template ? process.env.VITE_UPDATE_URL || 'https://updates.snipersledger.app/ledger-auto/update.xml' : '',
  VITE_EXTENSION_VERSION: version,
  VITE_LICENSE_PUBLIC_KEY: template ? TEMPLATE_PLACEHOLDERS.licensePublicKey : process.env.VITE_LICENSE_PUBLIC_KEY || '',
};

// The licence key gate. Without a usable key nothing verifies: no offline
// grace, and every open EA tab polls GET /extension/kill-switch every 8 s,
// where a rate-limit 429 reads as "kill switch active" and halts the engine.
// So a release build must have one — the userscript included, which
// verifies the licence the same way. `--watch` (pnpm dev) only warns, and
// SL_ALLOW_NO_LICENSE_KEY=1 lets a non-shipping build (CI checks, tests) go
// without a key. A key that is set but unusable fails too, except under
// `--watch`. A `--template` build (`ledger-auto` or `userscript`) is exempt:
// its key is the placeholder the API replaces with its own
// ENTITLEMENT_PUBLIC_KEY at download time
// (apps/api/src/lib/extension-download.ts), so the key it ships with is
// checked there, not here.
const keyProblem = template ? null : licenseKeyProblem(env.VITE_LICENSE_PUBLIC_KEY);
if (keyProblem) {
  const optedOut = !env.VITE_LICENSE_PUBLIC_KEY && process.env.SL_ALLOW_NO_LICENSE_KEY === '1';
  if (watch || optedOut) {
    console.warn(`[build] WARNING: ${keyProblem} — this build cannot verify licences (no offline grace; kill switch polled). Never ship it.`);
  } else {
    console.error(
      `[build] ${keyProblem}.\n` +
        '  Set it to the API\'s ENTITLEMENT_PUBLIC_KEY (the PEM as-is). For a build that will not ship,\n' +
        '  set SL_ALLOW_NO_LICENSE_KEY=1 instead. See docs/06-extension.md, "Build targets".',
    );
    process.exit(1);
  }
}

const define = Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));

const sharedAlias = {
  '@sl/shared/adapter-channel.js': path.resolve(
    root,
    '../../packages/shared/src/adapter-channel.ts',
  ),
  '@sl/shared': path.resolve(root, '../../packages/shared/src/index.ts'),
  'virtual:autobuyer-loader': path.resolve(
    root,
    automation ? 'src/engine/autobuyer-loader.auto.ts' : 'src/engine/autobuyer-loader.ledger.ts',
  ),
};

/** @param {boolean} first whether this call should empty outDir first */
function baseConfig(first) {
  return {
    root,
    configFile: false,
    envDir: false,
    define,
    resolve: { alias: sharedAlias },
    build: {
      outDir,
      emptyOutDir: first,
      minify: true,
      // Not shipped to the Chrome Web Store / self-hosted update server
      // either way, and keeping them out of dist is also what makes the
      // "ledger never contains the word autobuyer" check (below) exact
      // rather than accidentally failing on a source map's embedded
      // original source text of an unrelated file that merely *mentions*
      // the word in a comment or a variable name.
      sourcemap: false,
      target: 'chrome110',
      watch: watch ? {} : undefined,
    },
  };
}

/**
 * zod and this repo's own schema modules are pure — no top-level side
 * effects — so telling Rollup that explicitly (rather than relying on its
 * conservative default) is safe, and it is what lets an unused schema (e.g.
 * `bootstrapResponseSchema`, which only ever crosses this codebase as a
 * TypeScript type, never a runtime value) be fully eliminated instead of
 * dragging its dependencies — here, `FEATURE_KEYS`, whose values include the
 * literal string `'automation.autobuyer'` — into every bundle that imports
 * any *other* export of the same `@sl/shared` barrel module.
 */

const TREESHAKE = { moduleSideEffects: false };

async function buildLibEntry(entry, fileName, globalName, first) {
  await build({
    ...baseConfig(first),
    build: {
      ...baseConfig(first).build,
      lib: {
        entry: path.join(root, entry),
        formats: ['iife'],
        name: globalName,
        fileName: () => fileName,
      },
      rollupOptions: { treeshake: TREESHAKE, output: { extend: true } },
    },
  });
}

async function buildEsGroup(first) {
  await build({
    ...baseConfig(first),
    build: {
      ...baseConfig(first).build,
      rollupOptions: {
        treeshake: TREESHAKE,
        input: Object.fromEntries(Object.entries(ES_GROUP_INPUTS).map(([name, entry]) => [name, path.join(root, entry)])),
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
}

function writeManifest() {
  const manifest = buildManifest(target, {
    version: pkg.version,
    apiOrigin: env.VITE_API_ORIGIN,
    updateUrl: env.VITE_UPDATE_URL,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// ---- userscript target -------------------------------------------------------
//
// One self-contained Tampermonkey file (src/userscript/main.ts explains the
// layout). Two builds: the MAIN-world adapter first, exactly as the
// extension ships it, then everything else with that adapter embedded as a
// string (`virtual:adapter-source`) and `webextension-polyfill` swapped for
// src/userscript/browser-shim.ts. Not minified: a userscript is installed by
// hand, and people should be able to read what they are installing.

// `TREESHAKE` above marks every module side-effect free. The userscript's
// entry is a list of side-effect imports (setup, background, content), so it
// keeps side effects for this app's own modules; @sl/shared and zod stay
// pure, which is what that comment is about.
const USERSCRIPT_TREESHAKE = {
  moduleSideEffects: (id) => id.startsWith(path.join(root, 'src') + path.sep),
};

function adapterSourcePlugin(source) {
  const id = 'virtual:adapter-source';
  return {
    name: 'sl-adapter-source',
    resolveId: (spec) => (spec === id ? `\0${id}` : null),
    load: (resolved) =>
      resolved === `\0${id}` ? `export default ${JSON.stringify(source)};` : null,
  };
}

/** Runs a library-mode IIFE build without writing it, returning the code. */
async function buildIifeInMemory(entry, globalName, extra = {}) {
  const base = baseConfig(false);
  const result = await build({
    ...base,
    logLevel: 'warn',
    plugins: extra.plugins ?? [],
    resolve: { alias: { ...sharedAlias, ...(extra.alias ?? {}) } },
    build: {
      ...base.build,
      write: false,
      minify: extra.minify ?? true,
      lib: {
        entry: path.join(root, entry),
        formats: ['iife'],
        name: globalName,
        fileName: () => 'out.js',
      },
      rollupOptions: { treeshake: extra.treeshake ?? TREESHAKE, output: { extend: true } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === 'chunk');
  if (!chunk) throw new Error(`no output chunk for ${entry}`);
  return chunk.code;
}

async function buildUserscript() {
  const { adapter, main: entry } = USERSCRIPT_ENTRIES;
  const adapterSource = await buildIifeInMemory(adapter.entry, adapter.globalName);
  const code = await buildIifeInMemory(entry.entry, entry.globalName, {
    plugins: [adapterSourcePlugin(adapterSource)],
    alias: { 'webextension-polyfill': path.join(root, 'src/userscript/browser-shim.ts') },
    treeshake: USERSCRIPT_TREESHAKE,
    minify: false,
  });

  const header = buildUserscriptHeader({
    version,
    apiOrigin: env.VITE_API_ORIGIN,
    // Where the published file will live, if known — Tampermonkey then
    // checks the small .meta.js for new versions and installs updates. The
    // template points at the API's per-user download route
    // (apps/api/src/modules/downloads), token still a placeholder.
    downloadUrl: template
      ? `${TEMPLATE_PLACEHOLDERS.apiOrigin}/api/v1/downloads/userscript/${TEMPLATE_PLACEHOLDERS.userscriptToken}/nova-trade.user.js`
      : process.env.USERSCRIPT_DOWNLOAD_URL || '',
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, entry.fileName), `${header}\n\n${code}`);
  writeFileSync(path.join(outDir, entry.metaFileName), `${header}\n`);
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  if (target === 'userscript') {
    await buildUserscript();
    console.warn(`[build] ${target} -> ${path.relative(root, outDir)}`);
    return;
  }
  for (const [i, { entry, fileName, globalName }] of LIB_ENTRIES.entries()) {
    await buildLibEntry(entry, fileName, globalName, i === 0);
  }
  await buildEsGroup(false);
  writeManifest();
  console.warn(`[build] ${target} -> ${path.relative(root, outDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
