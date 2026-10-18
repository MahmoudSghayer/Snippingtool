// GET/PUT /api/v1/extension/bot-settings — the Nova AI bot's settings, kept
// per account so every browser the trader signs in on (another PC, a cloud
// machine) starts with the settings they chose.

import { userBotSettings } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { DEFAULT_BOT_SETTINGS, type BotSettings } from '@sl/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';

import type { FastifyInstance } from 'fastify';

const URL = '/api/v1/extension/bot-settings';
const TEST_PW = 'correcthorsebattery12';

function device(fingerprint: string) {
  return {
    fingerprint,
    name: 'Ext Test',
    browser: 'chrome',
    os: 'linux',
    extensionVersion: '0.1.0',
  };
}

function parseSetCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const cookies: Record<string, string> = {};
  for (const entry of list) {
    const [pair] = (entry as string).split(';');
    const [name, value] = pair!.split('=');
    if (name && value !== undefined) cookies[name.trim()] = value;
  }
  return cookies;
}

/** Registers, verifies and signs in: the bearer token the extension uses,
 * and the cookies a dashboard session would carry. */
async function signIn(app: FastifyInstance, email: string, ip: string) {
  const fp = `botset-fp-${email}`.padEnd(24, '0');
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PW, device: device(fp), acceptTerms: true },
  });
  const token = decodeURIComponent(
    app.mailer.sentEmails.at(-1)!.html.match(/token=([A-Za-z0-9_-]+)/)![1]!,
  );
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    remoteAddress: ip,
    payload: { token },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { email, password: TEST_PW, device: device(fp) },
  });
  return {
    accessToken: login.json().accessToken as string,
    cookies: parseSetCookies(login),
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const withDelay = (min: number, max: number): BotSettings => ({
  ...DEFAULT_BOT_SETTINGS,
  searchDelay: { min, max },
});

describe('extension module: bot settings', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('requires a signed-in user for both GET and PUT', async () => {
    const get = await app.inject({ method: 'GET', url: URL });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: URL,
      payload: { settings: withDelay(2, 3) },
    });
    expect(put.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: URL,
      headers: bearer('not-a-real-token'),
    });
    expect(forged.statusCode).toBe(401);
  });

  it('starts with none, saves the settings as sent, and returns them on the next read', async () => {
    const { accessToken } = await signIn(app, 'botset-roundtrip@example.com', '198.51.100.80');

    const empty = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ settings: null, updatedAt: null });

    const settings = {
      ...withDelay(1.5, 2),
      thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 1_500 },
    };
    const put = await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { settings },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().settings).toEqual(settings);
    expect(typeof put.json().updatedAt).toBe('string');

    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().settings).toEqual(settings);
  });

  it('a PUT replaces the whole document', async () => {
    const { accessToken } = await signIn(app, 'botset-replace@example.com', '198.51.100.81');
    for (const settings of [withDelay(1.5, 2), withDelay(4, 6)]) {
      const res = await app.inject({
        method: 'PUT',
        url: URL,
        headers: bearer(accessToken),
        payload: { settings },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().settings).toEqual(withDelay(4, 6));
    expect(await app.db.query.userBotSettings.findMany()).toHaveLength(1);
  });

  it('is per user: another account neither sees nor overwrites the settings', async () => {
    const a = await signIn(app, 'botset-a@example.com', '198.51.100.82');
    const b = await signIn(app, 'botset-b@example.com', '198.51.100.83');
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(a.accessToken),
      payload: { settings: withDelay(1.5, 2) },
    });

    const bRead = await app.inject({ method: 'GET', url: URL, headers: bearer(b.accessToken) });
    expect(bRead.json()).toEqual({ settings: null, updatedAt: null });
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(b.accessToken),
      payload: { settings: withDelay(8, 9) },
    });

    const aRead = await app.inject({ method: 'GET', url: URL, headers: bearer(a.accessToken) });
    expect(aRead.json().settings).toEqual(withDelay(1.5, 2));
  });

  it("refuses settings outside the bot's limits or with unknown fields, and keeps what was stored", async () => {
    const { accessToken } = await signIn(app, 'botset-invalid@example.com', '198.51.100.84');
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { settings: withDelay(1.5, 2) },
    });

    for (const payload of [
      { settings: withDelay(0.1, 2) }, // below the 0.5 s minimum search delay
      { settings: { ...withDelay(1.5, 2), turbo: true } },
      { settings: withDelay(1.5, 2), extra: 1 },
      {},
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: URL,
        headers: bearer(accessToken),
        payload,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    }
    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().settings).toEqual(withDelay(1.5, 2));
  });

  it('refuses an oversize body before reading it (413)', async () => {
    const { accessToken } = await signIn(app, 'botset-oversize@example.com', '198.51.100.85');
    const res = await app.inject({
      method: 'PUT',
      url: URL,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ settings: DEFAULT_BOT_SETTINGS, padding: 'x'.repeat(64 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('a cookie session needs the CSRF token to save; a bearer token does not', async () => {
    const { cookies } = await signIn(app, 'botset-csrf@example.com', '198.51.100.86');
    const sessionCookies = { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! };

    const noToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      payload: { settings: withDelay(2, 3) },
    });
    expect(noToken.statusCode).toBe(403);

    const withToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      headers: { 'x-csrf-token': cookies.sl_csrf! },
      payload: { settings: withDelay(2, 3) },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);

    const read = await app.inject({ method: 'GET', url: URL, cookies: sessionCookies });
    expect(read.json().settings).toEqual(withDelay(2, 3));
  });

  it('reads a stored document the schema no longer accepts as none, instead of failing the read', async () => {
    const { accessToken } = await signIn(app, 'botset-stale@example.com', '198.51.100.87');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(accessToken),
    });
    await app.db.insert(userBotSettings).values({
      id: newId(),
      userId: me.json().id,
      settings: { searchDelay: 'fast', fromAnOlderBuild: true },
    });

    const res = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toBeNull();
    expect(typeof res.json().updatedAt).toBe('string');
  });
});
