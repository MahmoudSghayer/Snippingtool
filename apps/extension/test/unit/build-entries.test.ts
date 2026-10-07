// Every file the manifest names must be built, by the real build and by the
// e2e suite's own build (tests/e2e/build-extension.mjs). The e2e build once
// lacked handoff.js, and Chrome refuses to load an extension whose content
// script is missing, so journey (b) could not even start.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ES_GROUP_INPUTS, LIB_ENTRIES } from '../../scripts/entries.mjs';
import { buildManifest } from '../../scripts/generate-manifest.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');

interface Manifest {
  background: { service_worker: string };
  content_scripts: { js: string[] }[];
  icons: Record<string, string>;
  action: { default_popup: string; default_icon: Record<string, string> };
}

function manifestFiles(manifest: Manifest): string[] {
  return [manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js)];
}

/** Every non-script file the manifest names. Chrome refuses to load an
 * unpacked extension when one of these is missing too, not just a script. */
function manifestAssets(manifest: Manifest): string[] {
  return [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
  ];
}

describe('extension build entries', () => {
  it('the entry list covers every script the manifest names, for both targets', () => {
    const emitted = new Set([
      ...LIB_ENTRIES.map((e) => e.fileName),
      ...Object.keys(ES_GROUP_INPUTS).map((name) => `${name}.js`),
    ]);
    for (const target of ['ledger', 'ledger-auto']) {
      const manifest = buildManifest(target, { version: '1.0.0', apiOrigin: 'https://api.example.test', updateUrl: '' }) as unknown as Manifest;
      for (const file of manifestFiles(manifest)) expect(emitted, `${target}: ${file}`).toContain(file);
    }
  });

  it("the e2e suite's own build emits every script its manifest names", () => {
    const res = spawnSync(process.execPath, ['tests/e2e/build-extension.mjs', 'http://127.0.0.1:3100'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    const outDir = path.join(repoRoot, 'tests', 'e2e', '.artifacts', 'extension-dist', 'ledger');
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as Manifest;
    const missing = [...manifestFiles(manifest), ...manifestAssets(manifest)].filter(
      (file) => !existsSync(path.join(outDir, file)),
    );
    expect(missing).toEqual([]);
    expect(manifestFiles(manifest)).toContain('handoff.js');
  }, 180_000);
});
