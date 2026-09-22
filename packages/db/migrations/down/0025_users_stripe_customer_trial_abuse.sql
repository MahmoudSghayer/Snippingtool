-- Down for 0025_users_stripe_customer_trial_abuse.sql
DROP INDEX IF EXISTS users_email_normalised_idx;
ALTER TABLE users DROP COLUMN IF EXISTS email_normalised;
DROP FUNCTION IF EXISTS normalise_email_for_abuse_check(text);
DROP INDEX IF EXISTS users_stripe_customer_id_unique;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
