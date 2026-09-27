// The licence public key reaches the extension in two ways: a release build
// bakes in the API's ENTITLEMENT_PUBLIC_KEY as-is (usually SPKI PEM), and the
// dashboard download (apps/api/src/lib/extension-download.ts) writes the raw
// Ed25519 key into the template build as its JWK `x` (base64url, 32 bytes).
// Both must verify a blob the API signed; a template whose placeholder was
// never filled in must fail closed, not throw.

import { createPublicKey } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEMPLATE_PLACEHOLDERS } from '../../scripts/template-placeholders.mjs';
import { importLicensePublicKey } from '../../src/lib/license.js';
import { logger } from '../../src/lib/logger.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';
import { API_SIGNED_BLOB, TEST_PUBLIC_KEY_PEM } from './license-test-keys.js';

function b64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** What the API's extension download substitutes for the placeholder:
 * exactly `rawEd25519PublicKey()` in apps/api/src/lib/extension-download.ts. */
function jwkX(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  return jwk.x as string;
}

async function verifiesApiBlob(key: CryptoKey | null): Promise<boolean> {
  if (!key) return false;
  const [h, c, s] = API_SIGNED_BLOB.split('.') as [string, string, string];
  return crypto.subtle.verify('Ed25519', key, b64urlToBytes(s) as BufferSource, new TextEncoder().encode(`${h}.${c}`));
}

describe('lib/license.ts importLicensePublicKey', () => {
  useRealChromeStorage();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts SPKI PEM, with real newlines or .env-style \\n escapes', async () => {
    expect(await verifiesApiBlob(await importLicensePublicKey(TEST_PUBLIC_KEY_PEM))).toBe(true);
    expect(await verifiesApiBlob(await importLicensePublicKey(TEST_PUBLIC_KEY_PEM.replace(/\n/g, '\\n')))).toBe(true);
  });

  it("accepts the raw key as base64url, the JWK `x` the API's download writes into the template", async () => {
    const x = jwkX(TEST_PUBLIC_KEY_PEM);
    expect(x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifiesApiBlob(await importLicensePublicKey(x))).toBe(true);
  });

  it('fails closed with a clear log on an unfilled template placeholder', async () => {
    const error = vi.spyOn(logger, 'error');
    await expect(importLicensePublicKey(TEMPLATE_PLACEHOLDERS.licensePublicKey)).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/placeholder/), 'license');
  });

  it('returns null (never throws) for no key or garbage', async () => {
    await expect(importLicensePublicKey('')).resolves.toBeNull();
    await expect(importLicensePublicKey(undefined)).resolves.toBeNull();
    await expect(importLicensePublicKey('not a key')).resolves.toBeNull();
  });
});
