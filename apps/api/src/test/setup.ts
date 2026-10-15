// Per-worker vitest setup: loads .env so JWT/entitlement keys and other
// local-dev secrets are available inside the test worker even though
// `globalSetup` runs in a separate context. Safe to import repeatedly
// (dotenv is idempotent — it never overwrites an already-set var).
import 'dotenv/config';

// Login 2FA is off by default (config/env.ts MFA_ENABLED); these tests were
// written against the 2FA flow (admins enroll, enrolled users verify), so
// they run with it on. The off path has its own tests.
process.env.MFA_ENABLED ??= 'true';
