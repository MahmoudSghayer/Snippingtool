// Production hardening of the env schema (docs/09-security.md "Encryption
// in transit" / "Secrets hygiene"): dev/test keep every convenient default,
// but NODE_ENV=production must refuse to boot with the dev COOKIE_SECRET,
// missing JWT/entitlement keys, a DATABASE_URL with no sslmode, or a
// REDIS_URL that isn't TLS (rediss://).

import { beforeEach, describe, expect, it } from 'vitest';

import { loadEnv, resetEnvCacheForTests } from '../env.js';

const REAL_KEY_PLACEHOLDER = 'x'.repeat(64); // shape doesn't matter here — only presence is checked by this refinement

function baseProdSource(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    COOKIE_SECRET: 'a-real-production-secret-that-is-long-enough',
    JWT_PRIVATE_KEY: REAL_KEY_PLACEHOLDER,
    JWT_PUBLIC_KEY: REAL_KEY_PLACEHOLDER,
    ENTITLEMENT_SIGNING_KEY: REAL_KEY_PLACEHOLDER,
    ENTITLEMENT_PUBLIC_KEY: REAL_KEY_PLACEHOLDER,
    DATABASE_URL: 'postgres://sl:sl@db.internal:5432/sniper_ledger?sslmode=require',
    REDIS_URL: 'rediss://redis.internal:6380',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('env schema: production hardening', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
  });

  it('a fully-configured production env loads cleanly', () => {
    expect(() => loadEnv(baseProdSource())).not.toThrow();
  });

  it('refuses the default dev COOKIE_SECRET in production', () => {
    expect(() =>
      loadEnv(baseProdSource({ COOKIE_SECRET: 'dev-cookie-secret-change-me-32-bytes-min' })),
    ).toThrow(/COOKIE_SECRET/);
  });

  it('refuses to boot without JWT keys in production', () => {
    expect(() =>
      loadEnv(baseProdSource({ JWT_PRIVATE_KEY: undefined, JWT_PUBLIC_KEY: undefined })),
    ).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('refuses to boot without entitlement signing keys in production', () => {
    expect(() =>
      loadEnv(
        baseProdSource({ ENTITLEMENT_SIGNING_KEY: undefined, ENTITLEMENT_PUBLIC_KEY: undefined }),
      ),
    ).toThrow(/ENTITLEMENT_SIGNING_KEY/);
  });

  it('refuses a DATABASE_URL with no sslmode in production', () => {
    expect(() =>
      loadEnv(baseProdSource({ DATABASE_URL: 'postgres://sl:sl@db.internal:5432/sniper_ledger' })),
    ).toThrow(/sslmode/);
  });

  it('accepts sslmode=verify-full (stronger than require) too', () => {
    expect(() =>
      loadEnv(
        baseProdSource({
          DATABASE_URL: 'postgres://sl:sl@db.internal:5432/sniper_ledger?sslmode=verify-full',
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a plain (non-TLS) REDIS_URL in production', () => {
    expect(() => loadEnv(baseProdSource({ REDIS_URL: 'redis://redis.internal:6379' }))).toThrow(
      /rediss/,
    );
  });

  it('never applies any of the above under development or test (defaults are fine there)', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
    resetEnvCacheForTests();
    expect(() => loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('refuses COOKIE_SAME_SITE=none without COOKIE_SECURE in production', () => {
    expect(() =>
      loadEnv(baseProdSource({ COOKIE_SAME_SITE: 'none' } as Partial<NodeJS.ProcessEnv>)),
    ).toThrow(/COOKIE_SAME_SITE=none requires COOKIE_SECURE/);
  });

  it('refuses COOKIE_SAME_SITE=none when APP_ORIGIN/DASHBOARD_ORIGIN are not https', () => {
    expect(() =>
      loadEnv(
        baseProdSource({
          COOKIE_SAME_SITE: 'none',
          COOKIE_SECURE: 'true',
          DASHBOARD_ORIGIN: 'http://dashboard.example.com',
        } as Partial<NodeJS.ProcessEnv>),
      ),
    ).toThrow(/must both be https/);
  });

  it('accepts COOKIE_SAME_SITE=none with COOKIE_SECURE=true and both origins https', () => {
    expect(() =>
      loadEnv(
        baseProdSource({
          COOKIE_SAME_SITE: 'none',
          COOKIE_SECURE: 'true',
          APP_ORIGIN: 'https://api.example.com',
          DASHBOARD_ORIGIN: 'https://dashboard.example.com',
        } as Partial<NodeJS.ProcessEnv>),
      ),
    ).not.toThrow();
  });

  it('reports every production violation at once, not just the first', () => {
    resetEnvCacheForTests();
    try {
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://sl:sl@db.internal:5432/sniper_ledger',
        REDIS_URL: 'redis://redis.internal:6379',
      } as NodeJS.ProcessEnv);
      expect.fail('expected loadEnv to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/COOKIE_SECRET/);
      expect(message).toMatch(/JWT_PRIVATE_KEY/);
      expect(message).toMatch(/ENTITLEMENT_SIGNING_KEY/);
      expect(message).toMatch(/sslmode/);
      expect(message).toMatch(/rediss/);
    }
  });
});
