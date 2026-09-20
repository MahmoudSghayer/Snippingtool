// Per-worker vitest setup: loads .env so JWT/entitlement keys and other
// local-dev secrets are available inside the test worker even though
// `globalSetup` runs in a separate context. Safe to import repeatedly
// (dotenv is idempotent — it never overwrites an already-set var).
import 'dotenv/config';
