// Tampermonkey installs an update only when @version goes up. The template the
// API serves behind the dashboard's install link is rebuilt and installed on
// the server on every publish (.github/workflows/publish-userscript.yml), with
// USERSCRIPT_VERSION set to the published script's version. Without that the
// template would carry the bare package version on every publish, and
// installs from the dashboard would never see an update.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { TEMPLATE_PLACEHOLDERS } from '../../scripts/template-placeholders.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'sl-userscript-template-version-'));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('scripts/build.mjs userscript --template', () => {
  it('takes its @version from USERSCRIPT_VERSION, header and compiled-in alike', () => {
    const version = '0.1.0.202610151234';
    const env: NodeJS.ProcessEnv = { ...process.env, SL_EXT_OUT_DIR: outDir, USERSCRIPT_VERSION: version };
    const res = spawnSync(process.execPath, ['scripts/build.mjs', 'userscript', '--template'], {
      cwd: extensionRoot,
      env,
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);

    const script = readFileSync(path.join(outDir, 'nova-trade.user.js'), 'utf8');
    const meta = readFileSync(path.join(outDir, 'nova-trade.meta.js'), 'utf8');
    expect(script).toMatch(new RegExp(`^// @version\\s+${version.replace(/\./g, '\\.')}$`, 'm'));
    expect(meta).toMatch(new RegExp(`^// @version\\s+${version.replace(/\./g, '\\.')}$`, 'm'));
    // Still a template: the API fills in its origins and the user's token.
    expect(script).toContain(`/api/v1/downloads/userscript/${TEMPLATE_PLACEHOLDERS.userscriptToken}/nova-trade.meta.js`);
    expect(script.split(version).length - 1).toBeGreaterThan(1);
  }, 180_000);
});
