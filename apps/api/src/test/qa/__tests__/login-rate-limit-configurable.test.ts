// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #5 ("Defects found"): modules/auth/
// service.ts's login() ran its own Redis sliding-window rate limit
// (independent of the @fastify/rate-limit HTTP-level limiter registered on
// the same routes) using two hardcoded module constants
// (LOGIN_RATE_LIMIT_MAX = 20, LOGIN_RATE_LIMIT_WINDOW_MS = 15min),
// completely deaf to RATE_LIMIT_LOGIN_MAX/RATE_LIMIT_LOGIN_WINDOW_MS
// (config/env.ts) even though those are exactly the vars an operator would
// reach for to tune it (they already tune the sibling HTTP-level limiter on
// the very same route). Fixed by threading an optional
// `AuthContext.loginRateLimit` through from `modules/auth/index.ts`'s
// `ctx()` (sourced from `fastify.config`), with the previous hardcoded
// values kept as the default when a caller omits it.
//
// This calls `service.login()` directly (not over HTTP) so it can swap in
// a deliberately tiny `loginRateLimit` without mutating process.env (this
// suite's vitest config pins every file to one shared process —
// `poolOptions.forks.singleFork` — so touching global env here would risk
// leaking into whichever other qa/__tests__ file runs next).

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type AppError } from '../../../lib/errors.js';
import * as service from '../../../modules/auth/service.js';
import {
  buildTestApp,
  createUserSession,
  device,
  TEST_PASSWORD,
  type TestApp,
} from '../helpers.js';

import type { AuthContext } from '../../../modules/auth/service.js';

function baseCtx(app: TestApp): AuthContext {
  return {
    db: app.db,
    redis: app.redis,
    entitlements: app.entitlements,
    mailer: app.mailer,
    jwtPrivateKey: app.config.JWT_PRIVATE_KEY!,
    cookieSecret: app.config.COOKIE_SECRET,
  };
}

describe('login() Redis sliding-window rate limit is env-configurable (defect #5)', () => {
  let app: TestApp;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('defaults to the previous hardcoded 20/15min when AuthContext.loginRateLimit is omitted', async () => {
    const email = 'rl-default@example.com';
    await createUserSession(app, email, 'fp-rl-default-0000000001');
    const ctx = baseCtx(app); // no loginRateLimit override

    // createUserSession() above already made one real login() call for this
    // account (to obtain its session tokens), which itself counted against
    // the same per-account sliding window — so only 19 more attempts stay
    // under the default max of 20; the 20th (cumulative 21st) trips
    // RATE_LIMITED. Every attempt uses a distinct IP so the per-account
    // sliding window (not the per-IP one) is what's exercised.
    let lastError: unknown;
    for (let i = 0; i < 20; i += 1) {
      try {
        await service.login(
          ctx,
          { email, password: 'wrong-password-attempt', device: device(`fp-rl-default-loop-${i}`) },
          `198.51.100.${i + 1}`,
          'vitest',
        );
      } catch (err) {
        lastError = err;
        if (i < 19) {
          // Should be AUTH_INVALID_CREDENTIALS (wrong password), not a rate limit, before the cumulative 21st call.
          expect((err as AppError).code).not.toBe('RATE_LIMITED');
        }
      }
    }
    expect((lastError as AppError).code).toBe('RATE_LIMITED');
  });

  it('a small custom loginRateLimit trips well before the hardcoded default would', async () => {
    const email = 'rl-custom@example.com';
    await createUserSession(app, email, 'fp-rl-custom-0000000001');
    const ctx: AuthContext = { ...baseCtx(app), loginRateLimit: { max: 3, windowMs: 60_000 } };

    let sawRateLimited = false;
    let attempts = 0;
    for (let i = 0; i < 6 && !sawRateLimited; i += 1) {
      attempts += 1;
      try {
        await service.login(
          ctx,
          { email, password: 'wrong-password-attempt', device: device(`fp-rl-custom-loop-${i}`) },
          `198.51.100.${100 + i}`,
          'vitest',
        );
      } catch (err) {
        if ((err as AppError).code === 'RATE_LIMITED') sawRateLimited = true;
      }
    }

    expect(sawRateLimited).toBe(true);
    // Tripped at or before attempt 4 (max=3 -> the 4th call in the window
    // is the one that pushes the count over 3) — nowhere near the
    // hardcoded default's 21st attempt, proving the override actually took
    // effect rather than silently falling back to the module constant.
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it('the wired-up app (modules/auth/index.ts ctx()) honours fastify.config.RATE_LIMIT_LOGIN_MAX/_WINDOW_MS, not just the hardcoded default', async () => {
    // End-to-end sanity check over real HTTP: config/env.ts defaults
    // RATE_LIMIT_LOGIN_MAX to 20, the same number the old hardcoded
    // constant used — this only proves the plumbing is live (login() is
    // reading *something* off fastify.config and not erroring), the two
    // tests above are what actually pin the override behaviour.
    const email = 'rl-wired@example.com';
    await createUserSession(app, email, 'fp-rl-wired-00000000001');
    // Whatever the environment sets (apps/api/.env.example → 20, CI's
    // infra/env/.env.development.example → 100) must be what the app runs
    // with: a positive integer, not the old hardcoded constant's shape.
    expect(Number.isInteger(app.config.RATE_LIMIT_LOGIN_MAX)).toBe(true);
    expect(app.config.RATE_LIMIT_LOGIN_MAX).toBeGreaterThan(0);

    // Same device fingerprint createUserSession() registered above — a new
    // one would trip the (unrelated) per-plan device-limit check instead of
    // exercising what this test is actually about.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '198.51.100.200',
      payload: { email, password: TEST_PASSWORD, device: device('fp-rl-wired-00000000001') },
    });
    expect(res.statusCode).toBe(200);
  });
});
