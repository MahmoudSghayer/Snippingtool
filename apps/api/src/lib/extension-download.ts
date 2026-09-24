// Builds the downloadable Nova Trade extension (`ledger-auto`) and its
// Tampermonkey userscript for this deployment.
//
// The extension bakes its API origin, dashboard origin and license public key
// in at build time. Rather than building a different zip for every deployment,
// the image ships one template build (`node scripts/build.mjs ledger-auto
// --template`) whose values are placeholders, and this module fills them in
// with the API's own configuration the first time the download is asked for.
// The zip is then cached for the life of the process.
//
// The userscript works the same way (`userscript --template`, one file), and
// additionally carries a placeholder download token in its @downloadURL and
// @updateURL, replaced per request with the user's signed token
// (lib/userscript-token.ts).

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
  userscriptToken: 'NOVA_USERSCRIPT_TOKEN_PLACEHOLDER',
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

function rawEd25519PublicKey(pem: string | undefined): string {
  if (!pem) return '';
  const jwk = createPublicKey(pem.replace(/\\n/g, '\n')).export({ format: 'jwk' });
  return typeof jwk.x === 'string' ? jwk.x : '';
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

function originReplacements(config: ExtensionDownloadConfig): [string, string][] {
  const apiOrigin = stripTrailingSlash(config.apiOrigin);
  return [
    [TEMPLATE_PLACEHOLDERS.apiOrigin, apiOrigin],
    // The userscript's @connect names the bare host.
    [new URL(TEMPLATE_PLACEHOLDERS.apiOrigin).host, new URL(apiOrigin).host],
    [TEMPLATE_PLACEHOLDERS.dashboardOrigin, stripTrailingSlash(config.dashboardOrigin)],
    [TEMPLATE_PLACEHOLDERS.licensePublicKey, rawEd25519PublicKey(config.entitlementPublicKeyPem)],
  ];
}

/** Returns the zip for this deployment, or `null` when no template build is
 * present (e.g. an image built without it). */
export function getExtensionPackage(config: ExtensionDownloadConfig): ExtensionPackage | null {
  const dir = findTemplateDir(config.templateDir);
  if (!dir) return null;

  const replacements = originReplacements(config);
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

// ---- userscript ------------------------------------------------------------

export const USERSCRIPT_FILE = 'nova-trade.user.js';
export const USERSCRIPT_META_FILE = 'nova-trade.meta.js';

export interface UserscriptDownloadConfig extends ExtensionDownloadConfig {
  userscriptTemplateDir?: string;
}

export interface UserscriptPackage {
  version: string;
  /** The whole script for one user's download token. */
  script(token: string): string;
  /** Only its `==UserScript==` header, which Tampermonkey polls for updates. */
  meta(token: string): string;
}

let cachedUserscript: { key: string; pkg: UserscriptPackage } | null = null;

function userscriptCandidateDirs(configured: string | undefined): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    ...(configured ? [configured] : []),
    path.resolve(process.cwd(), 'downloads/userscript-template'),
    path.resolve(here, '../../../extension/dist/userscript-template'),
  ];
}

export function findUserscriptTemplate(configured?: string): string | null {
  for (const dir of userscriptCandidateDirs(configured)) {
    const file = path.join(dir, USERSCRIPT_FILE);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The userscript's per-user URLs on this API. */
export function userscriptUrls(apiOrigin: string, token: string) {
  const base = `${stripTrailingSlash(apiOrigin)}/api/v1/downloads/userscript/${encodeURIComponent(token)}`;
  return { install: `${base}/${USERSCRIPT_FILE}`, meta: `${base}/${USERSCRIPT_META_FILE}` };
}

/** Returns the userscript for this deployment, or `null` when no template
 * build is present. The origins are filled in once and cached; the token is
 * filled in per call. Its @downloadURL and @updateURL already point at
 * `userscriptUrls()` on APP_ORIGIN (the template build puts them there with
 * the placeholder origin and token). */
export function getUserscriptPackage(config: UserscriptDownloadConfig): UserscriptPackage | null {
  const file = findUserscriptTemplate(config.userscriptTemplateDir);
  if (!file) return null;

  const replacements = originReplacements(config);
  const cacheKey = JSON.stringify([file, replacements]);
  if (cachedUserscript?.key === cacheKey) return cachedUserscript.pkg;

  let text = readFileSync(file, 'utf8');
  for (const [placeholder, value] of replacements) text = text.split(placeholder).join(value);
  const end = text.indexOf('// ==/UserScript==');
  const header = end >= 0 ? text.slice(0, end + '// ==/UserScript=='.length) + '\n' : '';
  const version = /^\/\/ @version\s+(\S+)/m.exec(header)?.[1] ?? '0.0.0';

  const withToken = (t: string, token: string) =>
    t.split(TEMPLATE_PLACEHOLDERS.userscriptToken).join(encodeURIComponent(token));
  const pkg: UserscriptPackage = {
    version,
    script: (token) => withToken(text, token),
    meta: (token) => withToken(header, token),
  };
  cachedUserscript = { key: cacheKey, pkg };
  return pkg;
}
