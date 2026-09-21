// Zod-validated environment for @sl/api. Read once at boot (see server.ts /
// worker.ts); every field the "subscriptions" agent needs (STRIPE_*,
// ENTITLEMENT_SIGNING_KEY) is declared here even though this agent does not
// consume it, so their module never has to touch this file. If you extend
// this schema, keep additions optional/backward compatible — see the
// SKELETON_READY note on env.ts.

import { z } from 'zod';

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'))
  .default(false);

// Startup refusal of dev defaults in production (docs/09-security.md
// "Encryption in transit" / "Secrets hygiene"): every value below has a
// convenient default so `pnpm dev` works with zero setup, but that same
// default reaching a real production deploy (a forgotten env var, a copy-
// pasted `.env`) would silently ship with a guessable cookie-signing secret,
// no JWT keys (a 500 on the first login, not caught until then), or a
// database/Redis connection with no transport encryption. `refineForProduction`
// runs after the base schema parses and only throws under
// `NODE_ENV=production`, so dev/test are completely unaffected.
const DEV_COOKIE_SECRET_DEFAULT = 'dev-cookie-secret-change-me-32-bytes-min';

function refineForProduction(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.COOKIE_SECRET === DEV_COOKIE_SECRET_DEFAULT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECRET'],
      message: 'refusing to start in production with the default dev COOKIE_SECRET — set a real 32+ byte secret.',
    });
  }
  if (!env.JWT_PRIVATE_KEY || !env.JWT_PUBLIC_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PRIVATE_KEY'],
      message: 'JWT_PRIVATE_KEY/JWT_PUBLIC_KEY are required in production (generate with `pnpm --filter @sl/api keys:generate`).',
    });
  }
  if (!env.ENTITLEMENT_SIGNING_KEY || !env.ENTITLEMENT_PUBLIC_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENTITLEMENT_SIGNING_KEY'],
      message: 'ENTITLEMENT_SIGNING_KEY/ENTITLEMENT_PUBLIC_KEY are required in production.',
    });
  }
  // postgres.js honours `sslmode=` as a connection-string query param — this
  // only checks the string carries it, the actual TLS handshake is the
  // driver's job (plugins/db.ts).
  if (!/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL must set sslmode=require (or stronger) in production.',
    });
  }
  // ioredis enables TLS from the `rediss://` scheme alone (plugins/redis.ts
  // passes the URL straight through) — a plain `redis://` in production
  // would carry auth + every cached/queued payload unencrypted.
  if (!env.REDIS_URL.startsWith('rediss://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL must use the rediss:// (TLS) scheme in production.',
    });
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  // --- Data stores ---
  DATABASE_URL: z.string().min(1).default('postgres://sl:sl@127.0.0.1:5432/sniper_ledger'),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  // Logical Redis DB index used only under NODE_ENV=test (plugins/redis.ts,
  // src/test/global-setup.ts) — see the SKELETON_READY note on why this is a
  // dedicated DB index rather than a key prefix. Configurable so two test
  // suites that must not collide (e.g. this repo's own `pnpm test` run vs.
  // an ad hoc `TEST_DATABASE_URL=... REDIS_TEST_DB=14 pnpm test` pass) can
  // use different indices; default (15) is unchanged from before this was
  // configurable.
  REDIS_TEST_DB: z.coerce.number().int().min(0).max(15).default(15),

  // --- Origins / CORS ---
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:5173'),
  EXTENSION_IDS: z.string().default(''),

  // --- Cookies / CSRF ---
  COOKIE_SECRET: z.string().min(16).default('dev-cookie-secret-change-me-32-bytes-min'),

  // --- JWT (EdDSA) ---
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),

  // --- Entitlement signing (Ed25519) — declared for the subscriptions agent too ---
  ENTITLEMENT_SIGNING_KEY: z.string().min(1).optional(),
  ENTITLEMENT_PUBLIC_KEY: z.string().min(1).optional(),

  // --- Stripe (owned by the subscriptions/payments module) ---
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_BASIC: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ULTIMATE: z.string().optional(),
  STRIPE_PRICE_LIFETIME: z.string().optional(),

  // --- Email ---
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: boolFromString,
  EMAIL_FROM: z.string().min(1).default('"The Sniper\'s Ledger" <noreply@sniperledger.local>'),

  // --- Rate limiting ---
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Coarse per-route/per-IP HTTP throttle (@fastify/rate-limit), deliberately
  // looser than the 5-failure DB account lockout (users.failed_login_count /
  // locked_until, see modules/auth) — that lockout is the primary
  // brute-force defence per account; this is a blunter abuse guard against
  // one IP hammering the route at all (any account, or none).
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(900_000),

  // --- Extension distribution ---
  EXTENSION_LATEST_VERSION: z.string().min(1).default('0.1.0'),
  EXTENSION_UPDATE_URL: z.string().default(''),

  // --- Misc ---
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  SEED_ADMIN_EMAIL: z.string().optional(),

  // --- IP monitoring / geo enrichment (docs/09-security.md "IP monitoring") ---
  // Declared here (rather than left as an ad hoc `process.env` read) so
  // they're validated and documented like every other env var; `lib/geoip.ts`
  // still reads `process.env` directly (its `getGeoIpProvider()` is called
  // outside request context, before `fastify.config` exists in some call
  // sites), but an operator setting `GEOIP_PROVIDER` to anything other than
  // the three supported values now fails fast at boot instead of silently
  // falling back to the no-op provider.
  GEOIP_PROVIDER: z.enum(['noop', 'maxmind', 'ipinfo']).default('noop'),
  GEOIP_MAXMIND_DB_PATH: z.string().optional(),
  IPINFO_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

// See `refineForProduction` above — applied as a schema-level superRefine so
// every `loadEnv` caller (server.ts, worker.ts, every test's buildApp())
// gets it uniformly, with no separate "did you remember to call the
// production check" step to forget.
const validatedEnvSchema = envSchema.superRefine(refineForProduction);

let cached: Env | undefined;

/** Mirrors @sl/db's test-utils `getTestDatabaseUrl`: prefer an explicit
 * TEST_DATABASE_URL, else swap DATABASE_URL's trailing path segment for
 * `_test`. Applied automatically below so every consumer of
 * `env.DATABASE_URL` (plugins/db.ts, jobs, scripts) transparently targets
 * the test database under NODE_ENV=test without special-casing — this is
 * the fix for a real incident during development: without it, an
 * integration test's `resetDatabase()` truncated the *dev* database because
 * nothing redirected DATABASE_URL. */
function testDatabaseUrl(env: Env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  return env.DATABASE_URL.endsWith('_test') ? env.DATABASE_URL : `${env.DATABASE_URL}_test`;
}

/** Parses and validates `process.env` once, memoised. Throws a readable
 * error (via zod's message) if a required var is missing/malformed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = validatedEnvSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${message}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'test') {
    env.DATABASE_URL = testDatabaseUrl(env);
  }
  cached = env;
  return cached;
}

/** Test-only helper to reset the memoised env between test files that mutate
 * process.env before calling loadEnv again. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
