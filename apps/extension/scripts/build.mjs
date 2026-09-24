#!/usr/bin/env node
// build.mjs — builds one target (`ledger` or `ledger-auto`) of the
// extension. Plain Vite (programmatic API), not `@crxjs/vite-plugin`: crxjs
// pins itself to Vite <= 5's plugin hook signatures and does not yet support
// Vite 6 (the version this repo's other packages already standardise on —
// see packages/config), so this repo uses plain multi-entry Vite builds plus
// this hand-written manifest generator instead (docs/06-extension.md,
// "Build targets" documents this decision).
//
// Three separate `vite.build()` calls per target, not one multi-entry build,
// because content scripts must ship as a single self-contained file with no
// code-splitting (MV3 does not support ES module content scripts) while the
// service worker + popup + options page are ordinary ES modules that *can*
// share chunks:
//   1. adapter.js   — MAIN world,  library-mode IIFE, single entry
//   2. content.js   — ISOLATED world, library-mode IIFE, single entry
//   3. background.js + src/popup/index.html + src/options/index.html — ES
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

import { buildManifest } from './generate-manifest.mjs';
import { TEMPLATE_PLACEHOLDERS } from './template-placeholders.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const target = process.argv[2];
const watch = process.argv.includes('--watch');
if (target !== 'ledger' && target !== 'ledger-auto') {
  console.error(`usage: node scripts/build.mjs <ledger|ledger-auto> [--watch] [--template]`);
  process.exit(1);
}

// `--template` builds the downloadable `ledger-auto` zip's template: the
// API origin, dashboard origin and license public key are placeholders that
// the API fills in with its own configuration when it serves the download
// (apps/api/src/lib/extension-download.ts), so one image serves a correct
// extension on any deployment. The placeholders are exported from
// ./template-placeholders.mjs, which the API imports too.
const template = process.argv.includes('--template');
if (template && target !== 'ledger-auto') {
  console.error('--template only applies to ledger-auto');
  process.exit(1);
}

const outDir = path.join(root, 'dist', template ? 'ledger-auto-template' : target);

const env = {
  VITE_AUTOMATION: target === 'ledger-auto' ? '1' : '0',
  VITE_BUILD_TARGET: target,
  VITE_API_ORIGIN: template ? TEMPLATE_PLACEHOLDERS.apiOrigin : process.env.VITE_API_ORIGIN || 'https://api.snipersledger.app',
  // Where the companion site lives, for the install-time welcome tab
  // (background/welcome.ts). Same override story as VITE_API_ORIGIN:
  // set it in the environment to point a build at a self-hosted stack.
  VITE_DASHBOARD_ORIGIN: template ? TEMPLATE_PLACEHOLDERS.dashboardOrigin : process.env.VITE_DASHBOARD_ORIGIN || 'https://snipersledger.app',
  // An unpacked (downloaded) extension ignores update_url, so the template
  // doesn't declare one.
  VITE_UPDATE_URL: target === 'ledger-auto' && !template ? process.env.VITE_UPDATE_URL || 'https://updates.snipersledger.app/ledger-auto/update.xml' : '',
  VITE_EXTENSION_VERSION: pkg.version,
  VITE_LICENSE_PUBLIC_KEY: template ? TEMPLATE_PLACEHOLDERS.licensePublicKey : process.env.VITE_LICENSE_PUBLIC_KEY || '',
};

const define = Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));

const sharedAlias = {
  '@sl/shared/adapter-channel.js': path.resolve(root, '../../packages/shared/src/adapter-channel.ts'),
  '@sl/shared': path.resolve(root, '../../packages/shared/src/index.ts'),
  'virtual:autobuyer-loader': path.resolve(
    root,
    target === 'ledger-auto' ? 'src/engine/autobuyer-loader.auto.ts' : 'src/engine/autobuyer-loader.ledger.ts',
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
      lib: { entry: path.join(root, entry), formats: ['iife'], name: globalName, fileName: () => fileName },
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
        input: {
          background: path.join(root, 'src/background/index.ts'),
          popup: path.join(root, 'src/popup/index.html'),
          options: path.join(root, 'src/options/index.html'),
        },
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
  const manifest = buildManifest(target, { version: pkg.version, apiOrigin: env.VITE_API_ORIGIN, updateUrl: env.VITE_UPDATE_URL });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  await buildLibEntry('src/main/adapter.ts', 'adapter.js', 'SLAdapter', true);
  await buildLibEntry('src/content/index.ts', 'content.js', 'SLContent', false);
  await buildEsGroup(false);
  writeManifest();
  console.warn(`[build] ${target} -> ${path.relative(root, outDir)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
