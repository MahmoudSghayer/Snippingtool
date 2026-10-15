// The downloadable extension verifies entitlement blobs with the key the
// API writes into the template build at download time. That key must be the
// one ENTITLEMENT_SIGNING_KEY signs with, in a form the extension imports:
// its runtime import (apps/extension/src/lib/license.ts,
// importLicensePublicKey) takes a 32-byte base64/base64url string as a raw
// Ed25519 key, which is mirrored below with WebCrypto.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DefaultEntitlementProvider, type EntitlementSnapshot } from '../entitlements.js';
import { getExtensionPackage, TEMPLATE_PLACEHOLDERS } from '../extension-download.js';

import type { Database } from '@sl/db';

const SNAPSHOT: EntitlementSnapshot = {
  plan: 'pro',
  planName: 'Pro',
  status: 'active',
  features: ['automation.autobuyer'],
  deviceLimit: 2,
  expiresAt: null,
  currentPeriodEnd: null,
  license: null,
};

describe('lib/extension-download key substitution', () => {
  let templateDir: string;

  beforeAll(() => {
    templateDir = mkdtempSync(path.join(tmpdir(), 'nova-key-template-'));
    writeFileSync(
      path.join(templateDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '9.9.9' }),
    );
    writeFileSync(
      path.join(templateDir, 'background.js'),
      `const KEY="${TEMPLATE_PLACEHOLDERS.licensePublicKey}";`,
    );
  });

  afterAll(() => {
    rmSync(templateDir, { recursive: true, force: true });
  });

  it("writes a key the extension imports, and it verifies the API's own signed blob", async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const pkg = getExtensionPackage({
      templateDir,
      apiOrigin: 'https://api.example.test',
      dashboardOrigin: 'https://example.test',
      // As the env usually carries it: one line with `\n` escapes.
      entitlementPublicKeyPem: publicPem.replace(/\n/g, '\\n'),
    });
    expect(pkg).not.toBeNull();
    const files = unzipSync(pkg!.zip);
    const background = new TextDecoder().decode(files['nova-trade-extension/background.js']);
    expect(background).not.toContain(TEMPLATE_PLACEHOLDERS.licensePublicKey);
    const key = /const KEY="([^"]*)"/.exec(background)?.[1] ?? '';
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const blob = await new DefaultEntitlementProvider(
      {} as Database,
      privatePem,
    ).signEntitlementBlob(
      SNAPSHOT,
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      false,
    );

    // The extension's import: base64url -> bytes; 32 bytes -> 'raw'.
    const raw = new Uint8Array(Buffer.from(key, 'base64url'));
    expect(raw.length).toBe(32);
    const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    const [h, c, s] = blob.split('.') as [string, string, string];
    const ok = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      new Uint8Array(Buffer.from(s, 'base64url')),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
