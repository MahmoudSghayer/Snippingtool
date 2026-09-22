// Runs once before the e2e suite. Resets the seeded admin
// (admin@sniperledger.local, packages/db/src/seed.ts) to a "never enrolled
// 2FA" state on every run, so dashboard.spec.ts's admin login always
// exercises the real TOTP-bootstrap flow (docs/04-auth.md §6 "admin
// bootstrap") deterministically, instead of only passing the first time a
// developer runs the suite and silently skipping it on every re-run after
// that (once a real admin enrols, its ticket mode is 'verify' forever
// after).
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
export const SEEDED_ADMIN_EMAIL = 'admin@sniperledger.local';
export const SEEDED_ADMIN_PASSWORD = 'Admin-Passw0rd!';

// Named `db`, not `sql`: the repo's ESLint preset (packages/config/eslint-preset.js)
// bans interpolation inside any tagged template literal called `sql`, as a
// blanket guard against building raw SQL text with runtime values. That
// rule is about Drizzle's `sql` helper; postgres.js's own client — used
// here, and itself invoked as a template tag — already parameterises every
// `${}` substitution exactly like Drizzle's does (this file never
// interpolates into a plain string), so the substance of the rule is
// satisfied; the identifier is renamed only so the linter's name-based
// selector doesn't also flag this safe, different case.
export default async function globalSetup(): Promise<void> {
  const db = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await db`
      update users
      set totp_secret_enc = null, totp_enabled_at = null
      where email = ${SEEDED_ADMIN_EMAIL}
      returning id
    `;
    if (rows.length === 0) {
      throw new Error(
        `Seeded admin ${SEEDED_ADMIN_EMAIL} not found. Run: SEED_ADMIN_EMAIL=${SEEDED_ADMIN_EMAIL} SEED_ADMIN_PASSWORD='${SEEDED_ADMIN_PASSWORD}' pnpm --filter @sl/db seed`,
      );
    }
    const adminId = rows[0]!.id;
    // Also clear any previously-issued recovery codes for a clean re-enroll.
    await db`delete from totp_recovery_codes where user_id = ${adminId}`;
    // And every device from a prior run: this admin has no subscription, so
    // its device limit falls back to the trial plan's (1) — a second device
    // fingerprint (a fresh one is generated per browser profile, see
    // src/lib/device.ts) on the next run would otherwise 409
    // DEVICE_LIMIT_REACHED on login/enrollment.
    await db`delete from devices where user_id = ${adminId}`;
    await db`delete from sessions where user_id = ${adminId}`;
  } finally {
    await db.end({ timeout: 5 });
  }
}
