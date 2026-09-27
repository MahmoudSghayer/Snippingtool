// license-key.mjs — build-time check of VITE_LICENSE_PUBLIC_KEY, the
// Ed25519 public key `src/lib/license.ts` verifies the entitlement blob with
// (the API's ENTITLEMENT_PUBLIC_KEY). Accepts the same forms the runtime
// does: SPKI PEM (real newlines or the `\n` escapes .env files use), bare
// base64 SPKI DER, or a bare base64 32-byte raw key.
import { createPublicKey } from 'node:crypto';

// DER prefix that turns a raw 32-byte Ed25519 key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** `null` if `material` is a usable Ed25519 public key, otherwise why not.
 * @param {string | undefined} material */
export function licenseKeyProblem(material) {
  if (!material) return 'VITE_LICENSE_PUBLIC_KEY is not set';
  try {
    const body = material
      .replace(/\\n/g, '\n')
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    const der = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const spki = der.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, der]) : der;
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') {
      return `VITE_LICENSE_PUBLIC_KEY is a ${key.asymmetricKeyType} key, not Ed25519`;
    }
    return null;
  } catch (err) {
    return `VITE_LICENSE_PUBLIC_KEY does not parse as an Ed25519 public key (${err instanceof Error ? err.message : String(err)})`;
  }
}
