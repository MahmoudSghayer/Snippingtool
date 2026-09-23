// scripts/build.mjs refuses to produce a release build without a usable
// licence public key. Without one nothing verifies: no offline grace, and
// every open EA tab polls GET /extension/kill-switch every 8 s, where a
// shared-NAT rate limit (429) reads as "kill switch active" and halts the
// engine for no reason. The check runs before Vite starts, so these
// failures are fast; the success path (a real key) is exercised by
// ledger-build-adapter.test.ts, which builds with the test key.

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'sl-license-key-build-'));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function build(env: Record<string, string | undefined>) {
  const base: NodeJS.ProcessEnv = { ...process.env, SL_EXT_OUT_DIR: outDir };
  delete base.VITE_LICENSE_PUBLIC_KEY;
  delete base.SL_ALLOW_NO_LICENSE_KEY;
  return spawnSync(process.execPath, ['scripts/build.mjs', 'ledger'], { cwd: extensionRoot, env: { ...base, ...env }, encoding: 'utf8' });
}

describe('scripts/build.mjs: licence public key gate', () => {
  it('fails a release build with no key', () => {
    const res = build({});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/VITE_LICENSE_PUBLIC_KEY/);
  });

  it('fails a build whose key does not parse', () => {
    const res = build({ VITE_LICENSE_PUBLIC_KEY: 'not-a-key' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/VITE_LICENSE_PUBLIC_KEY/);
  });

  it('fails a build whose key parses but is not Ed25519', () => {
    const { publicKey } = generateKeyPairSync('x25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = build({ VITE_LICENSE_PUBLIC_KEY: pem });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Ed25519/);
  });

  it('fails a keyless build even with an invalid key and the opt-out set', () => {
    const res = build({ VITE_LICENSE_PUBLIC_KEY: 'not-a-key', SL_ALLOW_NO_LICENSE_KEY: '1' });
    expect(res.status).not.toBe(0);
  });

  it('builds without a key only when SL_ALLOW_NO_LICENSE_KEY=1 says so', () => {
    const res = build({ SL_ALLOW_NO_LICENSE_KEY: '1' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/VITE_LICENSE_PUBLIC_KEY/); // still warned about
  }, 180_000);

});
