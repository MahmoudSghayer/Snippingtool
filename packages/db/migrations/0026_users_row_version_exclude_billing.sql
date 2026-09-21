-- 0026_users_row_version_exclude_billing.sql
--
-- Defect #8 (docs/12-testing.md "Defects found"): `users` uses the generic
-- `bump_row_version()` trigger (0001_extensions_and_helpers.sql), which
-- bumps `row_version` on *any* UPDATE. `row_version` is embedded in every
-- access token's `ver` claim and compared on every authenticated request
-- (plugins/auth.ts) — a mismatch is AUTH_SESSION_REVOKED, forcing
-- re-login. `modules/payments/webhooks.ts`'s `handleCheckoutCompleted()`
-- backfills `users.stripe_customer_id` (0025) inside the same transaction
-- that activates a subscription — a plain `UPDATE users SET
-- stripe_customer_id = ...`, which is billing metadata, not a
-- security-relevant change, but the blanket trigger bumped `row_version`
-- for it anyway: the buyer's own already-issued access token (obtained
-- *before* the webhook landed, e.g. mid-checkout in another tab) went
-- stale the instant checkout.session.completed was processed, and their
-- very next authenticated request 401'd.
--
-- Fix: `users` gets its own trigger function that only bumps `row_version`
-- when something *other than* `stripe_customer_id` actually changed.
--
-- Why an exclude-list (bump on everything except stripe_customer_id)
-- rather than an allow-list of just the security-relevant columns the
-- defect writeup named (password_hash, email, status, role, totp_*,
-- deleted_at)? Two existing, deliberate call sites depend on "any `users`
-- UPDATE bumps row_version", not just those columns, and a strict
-- allow-list would silently break both:
--
--   1. `modules/auth/repo.ts`'s `bumpUserVersion()` — the enforcement half
--      of force-logout / password-change / disable-2FA session
--      invalidation (see its own comment) — forces a bump by touching
--      *only* `updated_at` (`UPDATE users SET updated_at = now() WHERE
--      id = ...`, immediately overwritten again by `set_updated_at`; the
--      point is only to fire this trigger). `updated_at` is not one of
--      the named "security-relevant" columns, so a strict allow-list would
--      make every `force-logout` call (defect #7, this same docs/
--      12-testing.md list) a silent no-op again — a regression at least as
--      bad as the one this migration fixes.
--   2. `modules/auth/service.ts`'s `completeLogin()` updates
--      `last_login_at`/`last_ip` on every login and explicitly documents
--      (see that function's own comment) that it *expects* this to bump
--      `row_version` too, and works around it by re-fetching the fresh
--      value for the token it's about to sign. Excluding this bookkeeping
--      pair from the trigger would change that already-relied-upon
--      behaviour, which is outside this defect's scope.
--
-- An exclude-list naming only the actual offending column (billing
-- metadata written by a process the account holder's own session had no
-- part in) fixes exactly the reported defect with no other behavioural
-- change: every other `users` UPDATE — including the two call sites above,
-- and any future one — keeps bumping `row_version` exactly as before.
-- Comparison is done via `to_jsonb(NEW/OLD)` minus the excluded keys (and
-- `row_version` itself, which this trigger is the one thing that's allowed
-- to change) rather than an exhaustive column list, so a later
-- `ALTER TABLE users ADD COLUMN ...` is security-relevant *by default* —
-- it participates in the bump unless someone deliberately adds it to the
-- exclusion here, the safer failure mode for anything touching session
-- validity.

CREATE OR REPLACE FUNCTION bump_users_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- `email_normalised` (0025) is a GENERATED ALWAYS ... STORED column —
  -- per Postgres's own documented semantics, a generated column's value in
  -- NEW is *unspecified* for the duration of a BEFORE ROW trigger (it's
  -- (re)computed from the final NEW.email only once every BEFORE trigger
  -- has run, immediately before the row is actually written). Confirmed
  -- empirically here: NEW.email_normalised reads NULL inside this
  -- trigger even on an UPDATE that never touches email at all. Comparing
  -- it would therefore make *every* UPDATE look like it changed something
  -- (NULL vs. OLD's real value), defeating the exclusion below entirely —
  -- so it's excluded from the diff the same way stripe_customer_id is.
  -- This is safe: email_normalised only ever changes when email does, and
  -- email is very much still covered by this comparison.
  IF (to_jsonb(NEW) - 'row_version' - 'stripe_customer_id' - 'email_normalised')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'row_version' - 'stripe_customer_id' - 'email_normalised')
  THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION bump_users_row_version() IS 'BEFORE UPDATE trigger for users only: bumps row_version unless the only column(s) that changed are billing metadata excluded here (currently just stripe_customer_id — see this migration''s own header comment for why this is an exclude-list, not an allow-list of "security-relevant" columns). row_version backs every access token''s ver claim (plugins/auth.ts) — an unwarranted bump forces every live session to re-login.';

-- Same trigger name as 0003_users.sql so this is a like-for-like
-- replacement (CREATE OR REPLACE TRIGGER requires Postgres 14+, which this
-- project targets) rather than a rename that would need a DROP first.
CREATE OR REPLACE TRIGGER trg_users_bump_row_version
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION bump_users_row_version();
