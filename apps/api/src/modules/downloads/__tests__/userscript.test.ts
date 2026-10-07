// The Tampermonkey userscript download: a signed per-user link (no session,
// because Tampermonkey fetches it itself), served only while the user's pass
// includes the autobuyer, and built for this deployment's own origins with
// its update URLs pointing back at the same signed link.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { TEMPLATE_PLACEHOLDERS } from '../../../lib/extension-download.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { signUserscriptToken, verifyUserscriptToken } from '../../../lib/userscript-token.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { activateManual } from '../../subscriptions/service.js';

import type { FastifyInstance } from 'fastify';

const P = TEMPLATE_PLACEHOLDERS;
const SCRIPT_BASE = `${P.apiOrigin}/api/v1/downloads/userscript/${P.userscriptToken}`;
// What `node scripts/build.mjs userscript --template` writes, in miniature.
const TEMPLATE = `// ==UserScript==
// @name         Nova Trade
// @version      1.2.3
// @connect      ${new URL(P.apiOrigin).host}
// @updateURL    ${SCRIPT_BASE}/nova-trade.meta.js
// @downloadURL  ${SCRIPT_BASE}/nova-trade.user.js
// ==/UserScript==

const API="${P.apiOrigin}";const SITE="${P.dashboardOrigin}";const KEY="${P.licensePublicKey}";
`;

describe('userscript token', () => {
  it('round-trips, and rejects a tampered token or another secret', () => {
    // A test-only HMAC key, not a real secret.
    const secret = 'a-test-cookie-secret-of-32-bytes!!'; // nosemgrep: no-hardcoded-secret-const
    const userId = newId();
    const token = signUserscriptToken(userId, secret);
    expect(verifyUserscriptToken(token, secret)).toBe(userId);

    const other = newId();
    const [, sig] = token.split('.');
    expect(verifyUserscriptToken(`${other}.${sig}`, secret)).toBeNull();
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyUserscriptToken(flipped, secret)).toBeNull();
    expect(verifyUserscriptToken(userId, secret)).toBeNull();
    expect(verifyUserscriptToken(token, 'a-different-cookie-secret-32-bytes')).toBeNull();
  });
});

describe('downloads module (/api/v1/downloads/userscript)', () => {
  let app: FastifyInstance;
  let templateDir: string;

  beforeAll(async () => {
    templateDir = mkdtempSync(path.join(tmpdir(), 'nova-userscript-'));
    writeFileSync(path.join(templateDir, 'nova-trade.user.js'), TEMPLATE);
    process.env.USERSCRIPT_TEMPLATE_DIR = templateDir;
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.USERSCRIPT_TEMPLATE_DIR;
    rmSync(templateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  async function createUser(email: string, withPass: boolean) {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });
    if (withPass) {
      await activateManual(app.db, app.redis, {
        userId,
        planCode: 'pro',
        periodDays: 30,
        grantedByAdminId: null,
      });
    }
    const token = await signAccessToken(
      { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
      app.config.JWT_PRIVATE_KEY!,
    );
    return { userId, token };
  }

  async function installUrl(accessToken: string): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/downloads/userscript/link',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ installUrl: string }>().installUrl;
  }

  /** GET a URL on this API with no session at all, as Tampermonkey does. */
  const fetchAnon = (url: string) => app.inject({ method: 'GET', url: new URL(url).pathname });

  it('needs a signed-in user to hand out a link', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/downloads/userscript/link' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the script to a pass holder, built for this deployment', async () => {
    const { userId, token } = await createUser('monthly@example.com', true);
    const url = await installUrl(token);
    const apiOrigin = app.config.APP_ORIGIN.replace(/\/+$/, '');
    expect(url.startsWith(`${apiOrigin}/api/v1/downloads/userscript/`)).toBe(true);
    expect(url.endsWith('/nova-trade.user.js')).toBe(true);

    const res = await fetchAnon(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    const script = res.body;

    // Placeholders substituted.
    expect(script).toContain(`const API="${apiOrigin}"`);
    expect(script).toContain(`const SITE="${app.config.DASHBOARD_ORIGIN.replace(/\/+$/, '')}"`);
    expect(script).toContain(`// @connect      ${new URL(apiOrigin).host}`);
    for (const placeholder of Object.values(P)) expect(script).not.toContain(placeholder);

    // The update and download URLs are this user's tokenised ones.
    const userToken = signUserscriptToken(userId, app.config.COOKIE_SECRET);
    const base = `${apiOrigin}/api/v1/downloads/userscript/${userToken}`;
    expect(url).toBe(`${base}/nova-trade.user.js`);
    expect(script).toContain(`// @downloadURL  ${base}/nova-trade.user.js`);
    expect(script).toContain(`// @updateURL    ${base}/nova-trade.meta.js`);
    expect(script).toContain('// @version      1.2.3');

    const meta = await fetchAnon(`${base}/nova-trade.meta.js`);
    expect(meta.statusCode).toBe(200);
    expect(meta.body).toContain(`// @updateURL    ${base}/nova-trade.meta.js`);
    expect(meta.body.trim().endsWith('// ==/UserScript==')).toBe(true);
    expect(meta.body).not.toContain('const API=');
  });

  it('refuses a user without a pass, so installs and updates stop', async () => {
    const { token } = await createUser('no-pass@example.com', false);
    const url = await installUrl(token);
    expect((await fetchAnon(url)).statusCode).toBe(403);
    expect((await fetchAnon(url.replace(/user\.js$/, 'meta.js'))).statusCode).toBe(403);
  });

  // The userscript verifies the licence as the extension does: without a
  // usable Ed25519 key it would carry an empty one and verify nothing. The
  // same 503 as the zip download, after the token and pass checks.
  it('refuses with 503 when ENTITLEMENT_PUBLIC_KEY is missing or not Ed25519', async () => {
    const { token } = await createUser('no-key@example.com', true);
    const url = await installUrl(token);
    const original = app.config.ENTITLEMENT_PUBLIC_KEY;
    const { publicKey: x25519 } = generateKeyPairSync('x25519');
    try {
      for (const key of [undefined, x25519.export({ type: 'spki', format: 'pem' }).toString()]) {
        (app.config as { ENTITLEMENT_PUBLIC_KEY?: string }).ENTITLEMENT_PUBLIC_KEY = key;
        for (const file of [url, url.replace(/user\.js$/, 'meta.js')]) {
          const res = await fetchAnon(file);
          expect(res.statusCode, `${String(key)} ${file}`).toBe(503);
          expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
        }
      }
    } finally {
      (app.config as { ENTITLEMENT_PUBLIC_KEY?: string }).ENTITLEMENT_PUBLIC_KEY = original;
    }
    // Still a 403 without a pass, key or no key: the pass is checked first.
    const { token: noPass } = await createUser('no-pass-no-key@example.com', false);
    (app.config as { ENTITLEMENT_PUBLIC_KEY?: string }).ENTITLEMENT_PUBLIC_KEY = undefined;
    try {
      expect((await fetchAnon(await installUrl(noPass))).statusCode).toBe(403);
    } finally {
      (app.config as { ENTITLEMENT_PUBLIC_KEY?: string }).ENTITLEMENT_PUBLIC_KEY = original;
    }
  });

  it('refuses a tampered token', async () => {
    const { token } = await createUser('monthly@example.com', true);
    const url = await installUrl(token);
    const other = newId();
    const tampered = url.replace(/userscript\/[^.]+\./, `userscript/${other}.`);
    expect(tampered).not.toBe(url);
    expect((await fetchAnon(tampered)).statusCode).toBe(403);
    expect(
      (await fetchAnon(url.replace(/\.[^./]+\/nova-trade/, '.forged/nova-trade'))).statusCode,
    ).toBe(403);
  });
});
