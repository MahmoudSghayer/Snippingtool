// Builds the `ledger` extension target for journey (b) (extension <-> real
// API), pointed at *this test run's* API origin rather than the production
// default `https://api.snipersledger.app` baked into
// apps/extension/dist/ledger by apps/extension's own
// `pnpm --filter @sl/extension build` (that dist exists for
// apps/extension/test/e2e's own suite, which never talks to a real API —
// see that spec file's header — so its origin doesn't matter there).
// MV3 `host_permissions` are enforced per-origin, so an extension built for
// the production origin simply cannot fetch a local test API at all; this
// suite needs its own build with `VITE_API_ORIGIN` set to wherever
// playwright.config.ts's `webServer` is running apps/api.
//
// Deliberately writes to its own outDir (tests/e2e/.artifacts/extension-dist,
// gitignored) rather than apps/extension/dist/ledger — apps/extension is
// another agent's owned source tree, and CI's own extension-build /
// e2e-extension jobs rebuild apps/extension/dist themselves before running;
// sharing that directory would race whichever of "this suite" or "the
// extension's own e2e job" runs second in the same checkout.
//
// Otherwise mirrors apps/extension/scripts/build.mjs step-for-step — see
// that file for the full rationale (library-mode IIFE builds for the two
// content-script entries, an ES-module group for background/popup/options,
// a hand-written manifest). Imports that file's sibling
// generate-manifest.mjs directly (read-only — this suite never edits
// apps/extension's own files) rather than duplicating the manifest shape.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..');
const extensionRoot = path.join(repoRoot, 'apps', 'extension');
const outDir = path.join(dirname, '.artifacts', 'extension-dist', 'ledger');

export async function buildExtension(apiOrigin = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:3100') {
  const { buildManifest } = await import(path.join(extensionRoot, 'scripts', 'generate-manifest.mjs'));
  const pkg = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));

  const defineEnv = {
    VITE_AUTOMATION: '0',
    VITE_BUILD_TARGET: 'ledger',
    VITE_API_ORIGIN: apiOrigin,
    VITE_UPDATE_URL: '',
    VITE_EXTENSION_VERSION: pkg.version,
    VITE_LICENSE_PUBLIC_KEY: process.env.VITE_LICENSE_PUBLIC_KEY || '',
  };
  const define = Object.fromEntries(Object.entries(defineEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));

  const alias = {
    '@sl/shared/adapter-channel.js': path.resolve(repoRoot, 'packages/shared/src/adapter-channel.ts'),
    '@sl/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
    'virtual:autobuyer-loader': path.resolve(extensionRoot, 'src/engine/autobuyer-loader.ledger.ts'),
  };

  function baseConfig(emptyOutDirFirst) {
    return {
      root: extensionRoot,
      configFile: false,
      envDir: false,
      define,
      resolve: { alias },
      logLevel: 'warn',
      build: {
        outDir,
        emptyOutDir: emptyOutDirFirst,
        minify: false, // unminified — this build is only ever run + inspected locally/in CI, never shipped
        sourcemap: false,
        target: 'chrome110',
      },
    };
  }

  rmSync(outDir, { recursive: true, force: true });

  await build({
    ...baseConfig(true),
    build: {
      ...baseConfig(true).build,
      lib: { entry: path.join(extensionRoot, 'src/main/adapter.ts'), formats: ['iife'], name: 'SLAdapter', fileName: () => 'adapter.js' },
      rollupOptions: { treeshake: { moduleSideEffects: false }, output: { extend: true } },
    },
  });

  await build({
    ...baseConfig(false),
    build: {
      ...baseConfig(false).build,
      lib: { entry: path.join(extensionRoot, 'src/content/index.ts'), formats: ['iife'], name: 'SLContent', fileName: () => 'content.js' },
      rollupOptions: { treeshake: { moduleSideEffects: false }, output: { extend: true } },
    },
  });

  await build({
    ...baseConfig(false),
    build: {
      ...baseConfig(false).build,
      rollupOptions: {
        treeshake: { moduleSideEffects: false },
        input: {
          background: path.join(extensionRoot, 'src/background/index.ts'),
          popup: path.join(extensionRoot, 'src/popup/index.html'),
          options: path.join(extensionRoot, 'src/options/index.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });

  const manifest = buildManifest('ledger', { version: pkg.version, apiOrigin, updateUrl: '' });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.warn(`[tests/e2e] built extension (ledger, apiOrigin=${apiOrigin}) -> ${path.relative(repoRoot, outDir)}`);
  return outDir;
}

export const EXTENSION_OUT_DIR = outDir;

// Allow `node build-extension.mjs [apiOrigin]` standalone (e.g. for a
// developer poking at the build without running the whole suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildExtension(process.argv[2]);
}
