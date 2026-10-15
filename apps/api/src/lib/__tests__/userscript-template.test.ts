// The dashboard's userscript install link serves a template the API fills in
// per request (lib/extension-download.ts). In production that template lives
// in a host directory mounted at USERSCRIPT_TEMPLATE_DIR, which
// infra/scripts/publish-userscript.sh refreshes on every publish by renaming
// a new file into place. The running API has to serve the new file from the
// next request on, and has to fall back to the copy baked into its image
// while that directory is still empty.

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findUserscriptTemplate,
  getUserscriptPackage,
  TEMPLATE_PLACEHOLDERS,
  USERSCRIPT_FILE,
  type UserscriptDownloadConfig,
} from '../extension-download.js';

const P = TEMPLATE_PLACEHOLDERS;
const SCRIPT_BASE = `${P.apiOrigin}/api/v1/downloads/userscript/${P.userscriptToken}`;

/** What `build.mjs userscript --template` writes, in miniature. */
function template(version: string, body: string): string {
  return `// ==UserScript==
// @name         Nova Trade
// @version      ${version}
// @updateURL    ${SCRIPT_BASE}/nova-trade.meta.js
// @downloadURL  ${SCRIPT_BASE}/nova-trade.user.js
// ==/UserScript==

const API="${P.apiOrigin}";const BODY="${body}";
`;
}

/** Installs a template the way publish-userscript.sh does: written into a
 * temporary directory next to the live file, then renamed over it. */
function publish(dir: string, contents: string) {
  const incoming = path.join(dir, `.incoming-${process.pid}`);
  mkdirSync(incoming, { recursive: true });
  writeFileSync(path.join(incoming, USERSCRIPT_FILE), contents);
  renameSync(path.join(incoming, USERSCRIPT_FILE), path.join(dir, USERSCRIPT_FILE));
  rmSync(incoming, { recursive: true });
}

describe('lib/extension-download userscript template', () => {
  const originalCwd = process.cwd();
  let root: string;
  let config: Omit<UserscriptDownloadConfig, 'userscriptTemplateDir'>;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nova-userscript-template-'));
    const { publicKey } = generateKeyPairSync('ed25519');
    config = {
      apiOrigin: 'https://api.example.test',
      dashboardOrigin: 'https://example.test',
      entitlementPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a template published while it runs, script and meta.js alike', () => {
    const dir = path.join(root, 'published');
    mkdirSync(dir);
    publish(dir, template('1.0.0.202610150900', 'first'));
    const cfg = { ...config, userscriptTemplateDir: dir };

    const before = getUserscriptPackage(cfg)!;
    expect(before.version).toBe('1.0.0.202610150900');
    expect(before.script('tok')).toContain('const BODY="first"');
    // Cached between publishes: the same package object comes back.
    expect(getUserscriptPackage(cfg)).toBe(before);

    // Same length as before, so only the new inode (and mtime) tells the
    // files apart: a publish that only bumps the version stamp still lands.
    publish(dir, template('1.0.0.202610151000', 'secnd'));
    const after = getUserscriptPackage(cfg)!;
    expect(after.version).toBe('1.0.0.202610151000');
    expect(after.script('tok')).toContain('const BODY="secnd"');
    expect(after.script('tok')).toContain('const API="https://api.example.test"');
    expect(after.meta('tok')).toContain('// @version      1.0.0.202610151000');
    expect(after.meta('tok')).toContain(
      '// @updateURL    https://api.example.test/api/v1/downloads/userscript/tok/nova-trade.meta.js',
    );

    // A file copied over in place (not renamed) is noticed too.
    writeFileSync(path.join(dir, USERSCRIPT_FILE), template('1.0.1', 'copied in place'));
    expect(getUserscriptPackage(cfg)!.version).toBe('1.0.1');
  });

  it("falls back to the image's copy while the configured directory is empty", () => {
    // The API image's layout: cwd /app, its template in
    // /app/downloads/userscript-template.
    const app = path.join(root, 'app');
    const baked = path.join(app, 'downloads', 'userscript-template');
    mkdirSync(baked, { recursive: true });
    writeFileSync(path.join(baked, USERSCRIPT_FILE), template('0.1.0', 'baked'));
    // The mount before the first publish: present, but empty, apart from
    // an unfinished publish's leftovers.
    const mounted = path.join(root, 'mounted');
    mkdirSync(path.join(mounted, '.incoming-1'), { recursive: true });
    writeFileSync(path.join(mounted, '.incoming-1', USERSCRIPT_FILE), 'partial');
    process.chdir(app);
    const cfg = { ...config, userscriptTemplateDir: mounted };

    expect(findUserscriptTemplate(mounted)).toBe(
      path.join(process.cwd(), 'downloads', 'userscript-template', USERSCRIPT_FILE),
    );
    const fallback = getUserscriptPackage(cfg)!;
    expect(fallback.version).toBe('0.1.0');
    expect(fallback.script('tok')).toContain('const BODY="baked"');

    // A directory that doesn't exist at all is skipped the same way.
    expect(getUserscriptPackage({ ...cfg, userscriptTemplateDir: path.join(root, 'nope') })).toBe(
      fallback,
    );

    // The first publish switches over without a restart.
    publish(mounted, template('0.1.0.202610151100', 'published'));
    expect(findUserscriptTemplate(mounted)).toBe(path.join(mounted, USERSCRIPT_FILE));
    const published = getUserscriptPackage(cfg)!;
    expect(published.version).toBe('0.1.0.202610151100');
    expect(published.script('tok')).toContain('const BODY="published"');
  });
});
