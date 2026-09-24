-- Down for 0031_payment_claims.sql
-- The plan catalogue changes are data updates and are not reverted here; the
-- pre-0030 values are in packages/db/src/seed.ts's history.
ALTER TABLE users
  DROP COLUMN IF EXISTS terms_accepted_at,
  DROP COLUMN IF EXISTS terms_version;

DROP TABLE IF EXISTS payment_claims;

DROP TYPE IF EXISTS payment_claim_status;
