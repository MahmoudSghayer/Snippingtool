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
// that file for the full rationale (library-mode IIFE builds for the
// content-script entries, an ES-module group for background/popup/options,
// a hand-written manifest). Imports that file's siblings entries.mjs (the
// entry list, so this build emits every file the manifest names, handoff.js
// included) and generate-manifest.mjs directly (read-only — this suite never
// edits apps/extension's own files) rather than duplicating either.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..');
const extensionRoot = path.join(repoRoot, 'apps', 'extension');
const outDir = path.join(dirname, '.artifacts', 'extension-dist', 'ledger');

export async function buildExtension(
  apiOrigin = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:3100',
) {
  const { buildManifest } = await import(
    pathToFileURL(path.join(extensionRoot, 'scripts', 'generate-manifest.mjs')).href
  );
  const { LIB_ENTRIES, ES_GROUP_INPUTS } = await import(
    pathToFileURL(path.join(extensionRoot, 'scripts', 'entries.mjs')).href
  );
  const pkg = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));

  const defineEnv = {
    VITE_AUTOMATION: '0',
    VITE_BUILD_TARGET: 'ledger',
    VITE_API_ORIGIN: apiOrigin,
    VITE_UPDATE_URL: '',
    VITE_EXTENSION_VERSION: pkg.version,
    VITE_LICENSE_PUBLIC_KEY: process.env.VITE_LICENSE_PUBLIC_KEY || '',
  };
  const define = Object.fromEntries(
    Object.entries(defineEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]),
  );

  const alias = {
    '@sl/shared/adapter-channel.js': path.resolve(
      repoRoot,
      'packages/shared/src/adapter-channel.ts',
    ),
    '@sl/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
    'virtual:autobuyer-loader': path.resolve(
      extensionRoot,
      'src/engine/autobuyer-loader.ledger.ts',
    ),
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

  for (const [i, { entry, fileName, globalName }] of LIB_ENTRIES.entries()) {
    await build({
      ...baseConfig(i === 0),
      build: {
        ...baseConfig(i === 0).build,
        lib: {
          entry: path.join(extensionRoot, entry),
          formats: ['iife'],
          name: globalName,
          fileName: () => fileName,
        },
        rollupOptions: { treeshake: { moduleSideEffects: false }, output: { extend: true } },
      },
    });
  }

  await build({
    ...baseConfig(false),
    build: {
      ...baseConfig(false).build,
      rollupOptions: {
        treeshake: { moduleSideEffects: false },
        input: Object.fromEntries(
          Object.entries(ES_GROUP_INPUTS).map(([name, entry]) => [
            name,
            path.join(extensionRoot, entry),
          ]),
        ),
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
  // Same as build.mjs: Chrome refuses to load an unpacked extension whose
  // manifest names an icon that is not there, and with --load-extension that
  // refusal is a modal dialog that hangs launchPersistentContext.
  mkdirSync(path.join(outDir, 'icons'), { recursive: true });
  for (const file of Object.values(manifest.icons)) {
    copyFileSync(path.join(extensionRoot, 'src', file), path.join(outDir, file));
  }

  console.warn(
    `[tests/e2e] built extension (ledger, apiOrigin=${apiOrigin}) -> ${path.relative(repoRoot, outDir)}`,
  );
  return outDir;
}

export const EXTENSION_OUT_DIR = outDir;

// Allow `node build-extension.mjs [apiOrigin]` standalone (e.g. for a
// developer poking at the build without running the whole suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildExtension(process.argv[2]);
}
