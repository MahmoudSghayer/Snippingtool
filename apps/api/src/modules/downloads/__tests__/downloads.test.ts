// The extension download: only for a pass that includes the autobuyer, and
// always built for this deployment's own API and dashboard origins.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { TEMPLATE_PLACEHOLDERS } from '../../../lib/extension-download.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { activateManual } from '../../subscriptions/service.js';

import type { FastifyInstance } from 'fastify';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('downloads module (/api/v1/downloads/extension)', () => {
  let app: FastifyInstance;
  let templateDir: string;

  beforeAll(async () => {
    templateDir = mkdtempSync(path.join(tmpdir(), 'nova-template-'));
    writeFileSync(
      path.join(templateDir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Nova Trade',
        version: '1.2.3',
        host_permissions: [`${TEMPLATE_PLACEHOLDERS.apiOrigin}/*`],
      }),
    );
    mkdirSync(path.join(templateDir, 'assets'));
    writeFileSync(
      path.join(templateDir, 'assets', 'background.js'),
      `const API="${TEMPLATE_PLACEHOLDERS.apiOrigin}";const SITE="${TEMPLATE_PLACEHOLDERS.dashboardOrigin}";const KEY="${TEMPLATE_PLACEHOLDERS.licensePublicKey}";`,
    );
    process.env.EXTENSION_TEMPLATE_DIR = templateDir;
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.EXTENSION_TEMPLATE_DIR;
    rmSync(templateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  async function createUser(email: string) {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });
    const token = await signAccessToken(
      { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
      app.config.JWT_PRIVATE_KEY!,
    );
    return { userId, token };
  }

  const get = (token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('is refused without a pass that includes the autobuyer', async () => {
    const { token } = await createUser('no-pass@example.com');

    const info = await get(token, '/api/v1/downloads/extension/info');
    expect(info.json()).toMatchObject({ available: true, entitled: false, version: '1.2.3' });
    expect((await get(token, '/api/v1/downloads/extension')).statusCode).toBe(403);
  });

  it('serves a zip built for this deployment to a Monthly pass holder', async () => {
    const { userId, token } = await createUser('monthly@example.com');
    await activateManual(app.db, app.redis, {
      userId,
      planCode: 'pro',
      periodDays: 30,
      grantedByAdminId: null,
    });

    expect((await get(token, '/api/v1/downloads/extension/info')).json().entitled).toBe(true);

    const res = await get(token, '/api/v1/downloads/extension');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('nova-trade-extension-1.2.3.zip');

    const files = unzipSync(new Uint8Array(res.rawPayload));
    const background = new TextDecoder().decode(files['nova-trade-extension/assets/background.js']);
    const manifest = new TextDecoder().decode(files['nova-trade-extension/manifest.json']);
    const apiOrigin = app.config.APP_ORIGIN.replace(/\/+$/, '');

    expect(background).toContain(`const API="${apiOrigin}"`);
    expect(background).toContain(`const SITE="${app.config.DASHBOARD_ORIGIN.replace(/\/+$/, '')}"`);
    expect(manifest).toContain(`${apiOrigin}/*`);
    for (const placeholder of Object.values(TEMPLATE_PLACEHOLDERS)) {
      expect(background + manifest).not.toContain(placeholder);
    }
  });

  it("uses the same placeholders as the extension's template build", () => {
    const source = readFileSync(
      path.resolve(here, '../../../../../extension/scripts/template-placeholders.mjs'),
      'utf8',
    );
    for (const placeholder of Object.values(TEMPLATE_PLACEHOLDERS)) {
      expect(source).toContain(`'${placeholder}'`);
    }
  });
});
