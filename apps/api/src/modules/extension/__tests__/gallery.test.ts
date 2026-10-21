// GET/PUT /api/v1/extension/gallery — Nova AI's Gallery mode list (its
// cards and their progress, the fut.gg Sets on it, the Sets marked
// completed and when), kept per account so every browser the trader signs
// in on shows which Sets are done and which are not.

import { userGallery } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { EMPTY_GALLERY, GALLERY_LIMITS, type GalleryState } from '@sl/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';

import type { FastifyInstance } from 'fastify';

const URL = '/api/v1/extension/gallery';
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
  const fp = `gallery-fp-${email}`.padEnd(24, '0');
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

const MALAGA = {
  id: 90,
  name: 'Malaga CF',
  path: 'laliga/malaga-cf',
  grade: 'S' as const,
  threshold: 900,
  score: 908,
  tokens: 28,
  cost: 20_850,
};

/** A list with Malaga CF on it, its one card at `status`, and the Sets in
 * `completed` marked completed (with their times). */
function withSet(status: 'todo' | 'listed', completed: number[] = []): GalleryState {
  const state: GalleryState = {
    budget: 100_000,
    spent: status === 'listed' ? 3_100 : 0,
    sets: [MALAGA],
    cards: [
      {
        key: '243312:74#243312',
        name: 'Dani Lorenzo',
        rating: 74,
        playerId: 243312,
        resourceId: 243312,
        exact: true,
        setIds: [90],
        status,
        ...(status === 'listed' ? { price: 3_100, listPrice: 3_300 } : {}),
      },
    ],
  };
  if (completed.length > 0) {
    state.completed = completed;
    state.completedAt = Object.fromEntries(completed.map((id) => [String(id), 1_792_000_000_000]));
  }
  return state;
}

/** A list at every limit: 300 cards with every field at its longest, 40
 * Sets, 500 Sets completed with their times. `ch` fills every string. */
function fullList(ch: string): GalleryState {
  const big = Number.MAX_SAFE_INTEGER;
  const fill = (n: number) => ch.repeat(n);
  const completed = Array.from({ length: GALLERY_LIMITS.completed }, (_, i) => big - i);
  return {
    cards: Array.from({ length: GALLERY_LIMITS.cards }, (_, i) => ({
      key: fill(80 - String(i).length) + i,
      name: fill(GALLERY_LIMITS.nameLength),
      rating: GALLERY_LIMITS.rating.max,
      playerId: big,
      resourceId: big,
      rarity: 1_000,
      version: fill(GALLERY_LIMITS.versionLength),
      set: fill(GALLERY_LIMITS.setLength),
      exact: true as const,
      setIds: Array.from({ length: GALLERY_LIMITS.sets }, () => big),
      score: 10_000_000,
      guide: 15_000_000,
      status: 'skipped' as const,
      price: 15_000_000,
      market: 15_000_000,
      listPrice: 15_000_000,
      note: fill(GALLERY_LIMITS.noteLength),
      tradeId: fill(40),
    })),
    sets: Array.from({ length: GALLERY_LIMITS.sets }, (_, i) => ({
      id: big - i,
      name: fill(GALLERY_LIMITS.setLength),
      path: `${'a'.repeat(59)}/${'b'.repeat(60)}`,
      grade: 'S' as const,
      threshold: 100_000_000,
      score: 100_000_000,
      tokens: 10_000,
      cost: 1_000_000_000,
    })),
    completed,
    completedAt: Object.fromEntries(completed.map((id) => [String(id), big])),
    budget: GALLERY_LIMITS.budget.max,
    spent: 1_000_000_000,
  };
}

describe('extension module: Gallery list', () => {
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
    const put = await app.inject({ method: 'PUT', url: URL, payload: { state: EMPTY_GALLERY } });
    expect(put.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: URL,
      headers: bearer('not-a-real-token'),
    });
    expect(forged.statusCode).toBe(401);
  });

  it('starts with none, saves the list as sent, and returns it on the next read', async () => {
    const { accessToken } = await signIn(app, 'gallery-roundtrip@example.com', '198.51.100.90');

    const empty = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ state: null, updatedAt: null });

    const state = withSet('listed', [90, 54]);
    const put = await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { state },
    });
    expect(put.statusCode, put.body).toBe(200);
    // Only when it was saved: the list itself does not come back down.
    expect(Object.keys(put.json())).toEqual(['updatedAt']);
    expect(typeof put.json().updatedAt).toBe('string');

    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().state).toEqual(state);
    expect(read.json().updatedAt).toBe(put.json().updatedAt);
  });

  it('a PUT replaces the whole list: a Set marked completed, then undone', async () => {
    const { accessToken } = await signIn(app, 'gallery-replace@example.com', '198.51.100.91');
    for (const state of [withSet('listed', [90]), withSet('todo')]) {
      const res = await app.inject({
        method: 'PUT',
        url: URL,
        headers: bearer(accessToken),
        payload: { state },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().state).toEqual(withSet('todo'));
    expect(await app.db.query.userGallery.findMany()).toHaveLength(1);
  });

  it('is per user: another account neither sees nor overwrites the list', async () => {
    const a = await signIn(app, 'gallery-a@example.com', '198.51.100.92');
    const b = await signIn(app, 'gallery-b@example.com', '198.51.100.93');
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(a.accessToken),
      payload: { state: withSet('listed', [90]) },
    });

    const bRead = await app.inject({ method: 'GET', url: URL, headers: bearer(b.accessToken) });
    expect(bRead.json()).toEqual({ state: null, updatedAt: null });
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(b.accessToken),
      payload: { state: EMPTY_GALLERY },
    });

    const aRead = await app.inject({ method: 'GET', url: URL, headers: bearer(a.accessToken) });
    expect(aRead.json().state).toEqual(withSet('listed', [90]));
  });

  it("refuses a list past Gallery mode's limits or with unknown fields, and keeps what was stored", async () => {
    const { accessToken } = await signIn(app, 'gallery-invalid@example.com', '198.51.100.94');
    await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { state: withSet('listed', [90]) },
    });

    const ok = withSet('todo');
    for (const payload of [
      { state: { ...ok, budget: GALLERY_LIMITS.budget.max + 1 } },
      { state: { ...ok, cards: [{ ...ok.cards[0]!, status: 'sold' }] } },
      { state: { ...ok, completedAt: { '90': -1 } } },
      { state: { ...ok, turbo: true } },
      { state: ok, extra: 1 },
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
    expect(read.json().state).toEqual(withSet('listed', [90]));
  });

  it('takes a list at every limit, and refuses a body past 1 MiB before reading it (413)', async () => {
    // The worst case the body limit was picked from: about 460 KiB, and
    // about 600 KiB with every string made of quotes JSON escapes.
    const sizes = ['x', '"'].map((ch) =>
      Buffer.byteLength(JSON.stringify({ state: fullList(ch) })),
    );
    expect(sizes[0]).toBeGreaterThan(400 * 1024);
    expect(sizes[1]).toBeLessThan(1024 * 1024);

    const { accessToken } = await signIn(app, 'gallery-full@example.com', '198.51.100.95');
    const full = await app.inject({
      method: 'PUT',
      url: URL,
      headers: bearer(accessToken),
      payload: { state: fullList('"') },
    });
    expect(full.statusCode, full.body.slice(0, 300)).toBe(200);
    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(read.json().state).toEqual(fullList('"'));

    const oversize = await app.inject({
      method: 'PUT',
      url: URL,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ state: EMPTY_GALLERY, padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(oversize.statusCode).toBe(413);
  });

  it('a cookie session needs the CSRF token to save; a bearer token does not', async () => {
    const { cookies } = await signIn(app, 'gallery-csrf@example.com', '198.51.100.96');
    const sessionCookies = { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! };

    const noToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      payload: { state: withSet('todo') },
    });
    expect(noToken.statusCode).toBe(403);

    const withToken = await app.inject({
      method: 'PUT',
      url: URL,
      cookies: sessionCookies,
      headers: { 'x-csrf-token': cookies.sl_csrf! },
      payload: { state: withSet('todo') },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);

    const read = await app.inject({ method: 'GET', url: URL, cookies: sessionCookies });
    expect(read.json().state).toEqual(withSet('todo'));
  });

  it('reads a stored list the schema no longer accepts as none, instead of failing the read', async () => {
    const { accessToken } = await signIn(app, 'gallery-stale@example.com', '198.51.100.97');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(accessToken),
    });
    await app.db.insert(userGallery).values({
      id: newId(),
      userId: me.json().id,
      state: { cards: 'all of them', fromAnOlderBuild: true },
    });

    const res = await app.inject({ method: 'GET', url: URL, headers: bearer(accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBeNull();
    expect(typeof res.json().updatedAt).toBe('string');
  });
});
