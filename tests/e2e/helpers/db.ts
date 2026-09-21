// Direct-DB helpers for tests/e2e (owned by the Testing & QA agent — see
// docs/12-testing.md). Used only where there is no self-service HTTP route
// to reach the same state, mirroring apps/api/src/test/qa/helpers.ts's own
// convention (and tests/security/src/helpers.ts's).
//
// Two places this file touches the DB directly instead of driving a route:
//   1. Email verification: apps/api never exposes the raw verification
//      token over HTTP (only `email_verifications.token_hash` is stored —
//      see docs/04-auth.md — and the token itself only ever appears in the
//      *body* of an email the in-process `app.mailer.sentEmails` ring
//      buffer captures, which this out-of-process suite has no access to).
//      Rather than reimplement the email-sending/token-hashing contract
//      just to immediately throw it away, this stamps `email_verified_at`
//      directly — the verification *flow itself* (token minted, hashed,
//      single-use, expires) is already covered by
//      apps/api/src/modules/auth/__tests__/auth.test.ts; this suite's job
//      is what happens *after* a user is verified, across apps.
//   2. Admin promotion: there is deliberately no self-service "become an
//      admin" route (docs/04-auth.md) — every admin fixture in this repo's
//      test suites (apps/api/src/test/qa/helpers.ts's `createAdminSession`,
//      tests/security/src/helpers.ts) promotes via a direct `admin_users`
//      insert + `users.role` update for exactly this reason.
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';

// Named `db`, not `sql` — see apps/dashboard/e2e/global-setup.ts's identical
// comment: this repo's ESLint rule against interpolating into a `sql`
// tagged template is about Drizzle's `sql` helper, not postgres.js's own
// (which parameterises every `${}` the same safe way); renamed only so the
// name-based lint selector doesn't also flag this different, already-safe
// case.
export function connect() {
  return postgres(DATABASE_URL, { max: 4 });
}

/** Marks a user's email verified without going through the token flow (see
 * file header). Returns the user id. */
export async function markEmailVerified(db: ReturnType<typeof connect>, email: string): Promise<string> {
  const rows = await db<{ id: string }[]>`
    update users set email_verified_at = now() where email = ${email} returning id
  `;
  if (rows.length === 0) throw new Error(`markEmailVerified: no user with email ${email}`);
  return rows[0]!.id;
}

/** Promotes an already-registered, already-verified user to `admin` and
 * inserts its `admin_users` row (see file header, point 2). Idempotent:
 * safe to call again for the same user (upserts the admin_users row). */
export async function promoteToAdmin(
  db: ReturnType<typeof connect>,
  userId: string,
  adminRole: 'super_admin' | 'support' | 'analyst' | 'billing' = 'super_admin',
): Promise<void> {
  await db`update users set role = 'admin' where id = ${userId}`;
  const existing = await db<{ id: string }[]>`select id from admin_users where user_id = ${userId}`;
  if (existing.length === 0) {
    await db`insert into admin_users (id, user_id, admin_role, permissions) values (gen_random_uuid(), ${userId}, ${adminRole}, '{}'::jsonb)`;
  } else {
    await db`update admin_users set admin_role = ${adminRole}, deleted_at = null where user_id = ${userId}`;
  }
}

/** Cleans up every fixture this suite's specs create, by email prefix, so
 * repeated local runs against the same dev database start from a known
 * state without needing a full db:reset every time (globalSetup still does
 * a full reset+seed once per run — see prepare.mjs — this is extra
 * belt-and-braces for anyone re-running a single spec file directly). */
export async function deleteUsersByEmailPrefix(db: ReturnType<typeof connect>, prefix: string): Promise<void> {
  const rows = await db<{ id: string }[]>`select id from users where email like ${prefix + '%'}`;
  for (const { id } of rows) {
    // admin_actions.admin_user_id -> admin_users.id (no cascade) — a fixture
    // admin that actually performed an action during the spec (suspend,
    // force-logout, a toggle flip, ...) leaves a real admin_actions row
    // that must go first (reproduced while authoring journey (c)'s spec).
    await db`delete from admin_actions where admin_user_id in (select id from admin_users where user_id = ${id})`;
    await db`delete from admin_users where user_id = ${id}`;
    await db`delete from sessions where user_id = ${id}`;
    await db`delete from devices where user_id = ${id}`;
    await db`delete from licenses where user_id = ${id}`;
    // payments before subscriptions (payments.subscription_id FK, no
    // cascade — deleting a subscription first is a hard FK error).
    await db`delete from payments where user_id = ${id}`;
    await db`delete from subscriptions where user_id = ${id}`;
    // Deliberately explicit, not left to `ip_activity.user_id`'s own
    // `ON DELETE SET NULL`: every fixture user in one spec file shares the
    // same loopback IP, and `ip_activity_ip_user_unique` is a `NULLS NOT
    // DISTINCT` unique index (packages/db/migrations/0022_ip_installs.sql)
    // — deleting a second same-IP user would SET NULL its row and collide
    // with the first deleted user's row (also now NULL for the same ip),
    // raising a real `duplicate key value violates unique constraint
    // "ip_activity_ip_user_unique"` (reproduced while authoring this
    // suite). Deleting these rows outright, before the user, sidesteps the
    // cascade entirely rather than relying on it.
    await db`delete from ip_activity where user_id = ${id}`;
    await db`delete from users where id = ${id}`;
  }
}
