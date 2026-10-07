// Regression tests for two rate-limit evasion findings fixed in this change:
//
//  C1 — X-Forwarded-For spoofing: `trustProxy: true` let any client set
//       `request.ip` (which keys the limiter and IP-ban checks) to an
//       arbitrary value via a forged XFF, so rotating it per request minted
//       a fresh bucket and evaded the limit (and, in production, IP bans).
//       Fix: trust only the configured upstream proxies (TRUSTED_PROXY,
//       default loopback/link-local/unique-local). A request from an
//       untrusted (public) peer now has its XFF ignored.
//
//  C2 — forged JWT `sub`: the limiter's keyGenerator decoded the JWT payload
//       WITHOUT verifying the signature, so an unsigned token with a rotating
//       `sub` minted a fresh `ip:sub` bucket per request from one IP. Fix:
//       verify the signature; a forged token falls back to the per-IP key.
//
// Both are asserted against the real app with a deliberately low global limit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from './helpers.js';

const MAX = 5;

// A public, cheap, globally-rate-limited route (no per-route override).
const URL = '/api/v1/plans';

// Forge an unsigned JWT with an arbitrary `sub` (header.payload.sig where the
// signature is junk) — exactly the shape the old keyGenerator trusted.
function forgedToken(sub: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub, sid: 'x', role: 'user', ver: 1 })).toString('base64url');
  return `${h}.${p}.not-a-real-signature`;
}

describe('rate-limit evasion is closed (C1 XFF spoofing, C2 forged sub)', () => {
  let app: TestApp;
  const prev = {
    max: process.env.RATE_LIMIT_GLOBAL_MAX,
    win: process.env.RATE_LIMIT_GLOBAL_WINDOW_MS,
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_GLOBAL_MAX = String(MAX);
    process.env.RATE_LIMIT_GLOBAL_WINDOW_MS = '60000';
    const { resetEnvCacheForTests } = await import('@sl/api/app');
    resetEnvCacheForTests();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (prev.max === undefined) delete process.env.RATE_LIMIT_GLOBAL_MAX;
    else process.env.RATE_LIMIT_GLOBAL_MAX = prev.max;
    if (prev.win === undefined) delete process.env.RATE_LIMIT_GLOBAL_WINDOW_MS;
    else process.env.RATE_LIMIT_GLOBAL_WINDOW_MS = prev.win;
    const { resetEnvCacheForTests } = await import('@sl/api/app');
    resetEnvCacheForTests();
  });

  it('C1: a rotating X-Forwarded-For from one untrusted peer cannot escape the per-IP bucket', async () => {
    const socketIp = '203.0.113.10'; // one real peer (public, untrusted)
    let rejected = 0;
    for (let i = 0; i < MAX + 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: URL,
        remoteAddress: socketIp,
        headers: { 'x-forwarded-for': `10.0.0.${i}` }, // spoofed, must be ignored
      });
      if (res.statusCode === 429) rejected++;
    }
    expect(rejected, 'spoofed XFF must not mint fresh buckets — limit still trips').toBeGreaterThan(0);
  });

  it('C1 control: genuinely distinct socket peers each get their own bucket', async () => {
    // Different real peers (distinct remoteAddress) should NOT be throttled
    // against each other within the window.
    let rejected = 0;
    for (let i = 0; i < MAX; i++) {
      const res = await app.inject({ method: 'GET', url: URL, remoteAddress: `203.0.114.${i}` });
      if (res.statusCode === 429) rejected++;
    }
    expect(rejected, 'one request each from distinct IPs must not be throttled').toBe(0);
  });

  it('C2: a rotating forged (unsigned) JWT sub from one IP cannot escape the per-IP bucket', async () => {
    const socketIp = '203.0.113.20';
    let rejected = 0;
    for (let i = 0; i < MAX + 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: URL,
        remoteAddress: socketIp,
        headers: { authorization: `Bearer ${forgedToken(`attacker-${i}`)}` },
      });
      if (res.statusCode === 429) rejected++;
    }
    expect(rejected, 'forged sub must not mint fresh buckets — limit still trips').toBeGreaterThan(0);
  });
});
