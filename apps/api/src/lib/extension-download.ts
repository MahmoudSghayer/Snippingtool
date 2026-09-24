// Builds the downloadable Nova Trade extension (`ledger-auto`) for this
// deployment.
//
// The extension bakes its API origin, dashboard origin and license public key
// in at build time. Rather than building a different zip for every deployment,
// the image ships one template build (`node scripts/build.mjs ledger-auto
// --template`) whose values are placeholders, and this module fills them in
// with the API's own configuration the first time the download is asked for.
// The zip is then cached for the life of the process.

import { createPublicKey } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync, type Zippable } from 'fflate';

/** Must match apps/extension/scripts/template-placeholders.mjs (a test
 * checks they do). */
export const TEMPLATE_PLACEHOLDERS = {
  apiOrigin: 'https://nova-api-origin.placeholder.invalid',
  dashboardOrigin: 'https://nova-dashboard-origin.placeholder.invalid',
  licensePublicKey: 'NOVA_LICENSE_PUBLIC_KEY_PLACEHOLDER',
} as const;

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.map', '.txt']);

export interface ExtensionDownloadConfig {
  templateDir?: string;
  apiOrigin: string;
  dashboardOrigin: string;
  /** SPKI PEM (ENTITLEMENT_PUBLIC_KEY). The extension wants the raw 32-byte
   * Ed25519 key, base64url-encoded. */
  entitlementPublicKeyPem?: string;
}

export interface ExtensionPackage {
  version: string;
  fileName: string;
  zip: Uint8Array;
}

let cached: { key: string; pkg: ExtensionPackage } | null = null;

/** Where to look for the template, in order: the configured directory, the
 * API image's copy, and the monorepo's build output (for local runs). */
function candidateDirs(configured: string | undefined): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    ...(configured ? [configured] : []),
    path.resolve(process.cwd(), 'downloads/extension-template'),
    path.resolve(here, '../../../extension/dist/ledger-auto-template'),
  ];
}

export function findTemplateDir(configured?: string): string | null {
  for (const dir of candidateDirs(configured)) {
    if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

/** No usable Ed25519 ENTITLEMENT_PUBLIC_KEY: the zip would carry an empty
 * licence key, and that extension could verify nothing. */
export class ExtensionKeyUnavailableError extends Error {
  constructor(reason: string) {
    super(`extension download unavailable: ${reason}`);
    this.name = 'ExtensionKeyUnavailableError';
  }
}

/** The raw 32-byte Ed25519 key, base64url (its JWK `x`), which is what the
 * extension's importLicensePublicKey reads. Throws
 * ExtensionKeyUnavailableError when the key is missing or not Ed25519. */
function rawEd25519PublicKey(pem: string | undefined): string {
  if (!pem) throw new ExtensionKeyUnavailableError('ENTITLEMENT_PUBLIC_KEY is not set');
  let key;
  try {
    key = createPublicKey(pem.replace(/\\n/g, '\n'));
  } catch (err) {
    throw new ExtensionKeyUnavailableError(`ENTITLEMENT_PUBLIC_KEY does not parse (${String(err)})`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ExtensionKeyUnavailableError(`ENTITLEMENT_PUBLIC_KEY is ${key.asymmetricKeyType ?? 'unknown'}, not Ed25519`);
  }
  const { x } = key.export({ format: 'jwk' });
  if (typeof x !== 'string' || x.length !== 43) {
    throw new ExtensionKeyUnavailableError('ENTITLEMENT_PUBLIC_KEY has no 32-byte Ed25519 key');
  }
  return x;
}

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function collectFiles(dir: string, base = dir, out: Record<string, string> = {}) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = full;
  }
  return out;
}

/** Returns the zip for this deployment, or `null` when no template build is
 * present (e.g. an image built without it). Throws
 * ExtensionKeyUnavailableError when there is no usable licence key to put
 * in it. */
export function getExtensionPackage(config: ExtensionDownloadConfig): ExtensionPackage | null {
  const dir = findTemplateDir(config.templateDir);
  if (!dir) return null;

  const replacements: [string, string][] = [
    [TEMPLATE_PLACEHOLDERS.apiOrigin, stripTrailingSlash(config.apiOrigin)],
    [TEMPLATE_PLACEHOLDERS.dashboardOrigin, stripTrailingSlash(config.dashboardOrigin)],
    [TEMPLATE_PLACEHOLDERS.licensePublicKey, rawEd25519PublicKey(config.entitlementPublicKeyPem)],
  ];
  const cacheKey = JSON.stringify([dir, replacements]);
  if (cached?.key === cacheKey) return cached.pkg;

  const files: Zippable = {};
  for (const [relative, full] of Object.entries(collectFiles(dir))) {
    const bytes = readFileSync(full);
    if (TEXT_EXTENSIONS.has(path.extname(relative))) {
      let text = bytes.toString('utf8');
      for (const [placeholder, value] of replacements) text = text.split(placeholder).join(value);
      files[relative] = new TextEncoder().encode(text);
    } else {
      files[relative] = new Uint8Array(bytes);
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    version?: string;
  };
  const version = manifest.version ?? '0.0.0';
  const pkg: ExtensionPackage = {
    version,
    fileName: `nova-trade-extension-${version}.zip`,
    // Everything goes under one folder, so "Load unpacked" points at that
    // folder once the zip is extracted.
    zip: zipSync({ 'nova-trade-extension': files }, { level: 9 }),
  };
  cached = { key: cacheKey, pkg };
  return pkg;
}
