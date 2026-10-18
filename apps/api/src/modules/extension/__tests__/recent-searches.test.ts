// GET/PUT /api/v1/extension/recent-searches — the Nova AI page's Recent
// searches log, kept per account so every browser the trader signs in on
// shows the same list.

import { userRecentSearches } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { RECENT_SEARCHES_MAX, type RecentSearchDto } from '@sl/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';

const URL = '/api/v1/extension/recent-searches';
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
  const fp = `recent-fp-${email}`.padEnd(24, '0');
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

function entry(at: number, maxBuy: number | null = 52_000): RecentSearchDto {
  return {
    at,
    name: `86 Frenkie de Jong, max ${maxBuy ?? 'none'}`,
    form: {
      minOvr: 45,
      maxOvr: 99,
      player: { id: 228702, name: 'Frenkie de Jong', rating: 86 },
      playerQuery: '',
      quality: null,
      rarity: null,
      position: null,
      chem: null,
      nation: null,
      league: null,
      club: null,
      minBuy: null,
      maxBuy,
    },
  };
}

describe('extension module: recent searches', () => {
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
    const put = await app.inject({ method: 'PUT', url: URL, payload: { items: [] } });
    expect(put.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: URL,
      headers: bearer('not-a-real-token'),
    });
    expect(forged.statusCode).toBe(401);
  });

  it('starts empty, saves the list as sent, and returns it in order on the next read', async () => {
    const { accessToken } = await signIn(app, 'recent-roundtrip@example.com', '198.51.100.60');

    const empty = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [], updatedAt: null });

    const items = [entry(3_000, 50_000), entry(2_000, null), entry(1_000, 48_000)];
    const put = await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { items },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().items).toEqual(items);
    expect(Date.parse(put.json().updatedAt)).not.toBeNaN();

    const after = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(after.json()).toEqual(put.json());
  });

  it('a PUT replaces the whole list, an empty one included', async () => {
    const { accessToken } = await signIn(app, 'recent-replace@example.com', '198.51.100.61');
    const put = (items: RecentSearchDto[]) =>
      app.inject({ method: 'PUT', url: URL, headers: bearer(accessToken), payload: { items } });

    await put([entry(2_000), entry(1_000, 10_000)]);
    expect((await put([entry(5_000, 30_000)])).json().items).toEqual([entry(5_000, 30_000)]);
    expect((await put([])).json().items).toEqual([]);

    const rows = await app.db.select().from(userRecentSearches);
    expect(rows).toHaveLength(1); // one row per user, updated in place
  });

  it('is per user: another account neither sees nor overwrites the list', async () => {
    const a = await signIn(app, 'recent-owner-a@example.com', '198.51.100.62');
    const b = await signIn(app, 'recent-owner-b@example.com', '198.51.100.63');

    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(a.accessToken),
      payload: { items: [entry(1_000)] },
    });
    const seenByB = await app.inject({ method: 'GET', url: URL, headers: bearer(b.accessToken) });
    expect(seenByB.json()).toEqual({ items: [], updatedAt: null });

    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(b.accessToken),
      payload: { items: [entry(9_000, 1_000)] },
    });
    const seenByA = await app.inject({ method: 'GET', url: URL, headers: bearer(a.accessToken) });
    expect(seenByA.json().items).toEqual([entry(1_000)]);
  });

  it.each([
    [
      'more than the maximum',
      { items: Array.from({ length: RECENT_SEARCHES_MAX + 1 }, (_, i) => entry(i + 1)) },
    ],
    ['an unknown top-level key', { items: [], userId: 'someone-else' }],
    ['no items', {}],
    ['an unknown key in an entry', { items: [{ ...entry(1_000), extra: true }] }],
    [
      'an unknown key in the form',
      { items: [{ ...entry(1_000), form: { ...entry(1_000).form, x: 1 } }] },
    ],
    [
      'a form field missing',
      { items: [{ ...entry(1_000), form: { ...entry(1_000).form, club: undefined } }] },
    ],
    [
      'an OVR off the slider',
      { items: [{ ...entry(1_000), form: { ...entry(1_000).form, minOvr: 20 } }] },
    ],
    ['a price past EA’s cap', { items: [entry(1_000, 15_000_001)] }],
    ['an empty name', { items: [{ ...entry(1_000), name: '' }] }],
    ['a name too long', { items: [{ ...entry(1_000), name: 'x'.repeat(201) }] }],
    ['a string where a number goes', { items: [{ ...entry(1_000), at: '1000' }] }],
  ])('rejects a body with %s (400), leaving the list as it was', async (_label, payload) => {
    const { accessToken } = await signIn(app, 'recent-invalid@example.com', '198.51.100.64');
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { items: [entry(1_000)] },
    });

    const res = await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');

    const after = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(after.json().items).toEqual([entry(1_000)]);
  });

  it('refuses an oversize body before reading it (413)', async () => {
    const { accessToken } = await signIn(app, 'recent-oversize@example.com', '198.51.100.65');
    const res = await app.inject({
      method: 'PUT',
      url: URL,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ items: [], padding: 'x'.repeat(100 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('a cookie session needs the CSRF token to save; a bearer token does not', async () => {
    const { cookies } = await signIn(app, 'recent-csrf@example.com', '198.51.100.66');
    const sessionCookies = { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! };

    const noToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      payload: { items: [entry(1_000)] },
    });
    expect(noToken.statusCode).toBe(403);

    const withToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      headers: { 'x-csrf-token': cookies.sl_csrf! },
      payload: { items: [entry(1_000)] },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);

    // A read is not a mutation: no token needed.
    const read = await app.inject({ method: 'GET', url: URL, cookies: sessionCookies });
    expect(read.json().items).toEqual([entry(1_000)]);
  });

  it('leaves out a stored entry the schema no longer accepts, instead of failing the read', async () => {
    const { accessToken } = await signIn(app, 'recent-stale@example.com', '198.51.100.67');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(accessToken),
    });
    await app.db.insert(userRecentSearches).values({
      id: newId(),
      userId: me.json().id,
      items: [entry(2_000), { at: 1_000, name: 'from an older build', form: {} }],
    });

    const res = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([entry(2_000)]);
  });

  it(`is rate limited like the other extension sync routes (${INGEST_RATE_LIMIT.max}/min)`, async () => {
    const ip = '198.51.100.68';
    const { accessToken } = await signIn(app, 'recent-ratelimit@example.com', ip);
    const headers = { ...bearer(accessToken), 'x-forwarded-for': ip };

    let ok = 0;
    let firstRejection: number | undefined;
    for (let i = 1; i <= INGEST_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({
        method: 'PUT',
        url: URL,
        headers,
        remoteAddress: ip,
        payload: { items: [entry(i)] },
      });
      if (res.statusCode === 200) ok++;
      else firstRejection ??= res.statusCode;
    }
    expect(ok).toBe(INGEST_RATE_LIMIT.max);
    expect(firstRejection).toBe(429);
  }, 30_000);
});
