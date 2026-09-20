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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  // --- Data stores ---
  DATABASE_URL: z.string().min(1).default('postgres://sl:sl@127.0.0.1:5432/sniper_ledger'),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

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
});

export type Env = z.infer<typeof envSchema>;

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
  const parsed = envSchema.safeParse(source);
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
