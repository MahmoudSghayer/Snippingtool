-- 0025_users_stripe_customer_trial_abuse.sql
--
-- Two additive columns on `users`, both closing gaps flagged in
-- docs/05-subscriptions.md §5 ("Trial protection"):
--
-- 1. `stripe_customer_id` — the "dropped 4th trial-abuse vector". Persisted
--    the first time this user's Stripe Checkout completes (session.customer)
--    or their Customer Portal session resolves a customer, so trial requests
--    can be denied when another user already shares the same Stripe
--    customer id.
--
-- 2. `email_normalised` — a generated column backing an indexed lookup for
--    the existing "email" trial-abuse check (check 1), replacing the
--    previous full scan over every user who has ever had a trial. Kept
--    byte-for-byte in sync with `packages/shared/src/email-normalise.ts`'s
--    `normaliseEmailForAbuseCheck()` via an IMMUTABLE SQL function
--    (`normalise_email_for_abuse_check`) so the app-layer rule and the SQL
--    rule can never drift — Postgres recomputes it automatically on every
--    INSERT/UPDATE of `email`, so there is no application code path (and
--    therefore no owning module) responsible for keeping it fresh.

-- ---------------------------------------------------------------------------
-- users.stripe_customer_id
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN stripe_customer_id text;

-- Unique among non-null values: two users must never resolve to the same
-- live Stripe customer without the app knowing about it (that overlap is
-- exactly the "same Stripe customer" trial-abuse signal this column exists
-- to support).
CREATE UNIQUE INDEX users_stripe_customer_id_unique ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

COMMENT ON COLUMN users.stripe_customer_id IS 'Stripe Customer id, persisted the first time this user resolves one — checkout.session.completed''s session.customer, or the email-lookup fallback in POST /payments/portal (apps/api/src/modules/payments/service.ts#createPortalSession). Null until then. Unique among non-null values; also the trial-abuse 4th vector (docs/05-subscriptions.md §5) — POST /subscriptions/trial denies a trial when another user already shares this id.';

-- ---------------------------------------------------------------------------
-- users.email_normalised
-- ---------------------------------------------------------------------------

-- SQL mirror of packages/shared/src/email-normalise.ts's
-- normaliseEmailForAbuseCheck(): lower-case + trim, then for gmail.com/
-- googlemail.com only, strip a "+tag" local-part suffix and all dots,
-- canonicalising the domain to gmail.com. Exact for any well-formed
-- single-`@` address, which is the only shape `users.email` can hold (the
-- shared `emailSchema` gates registration) — malformed multi-`@`/no-`@`
-- input falls back to the trimmed/lower-cased string on both sides, same as
-- the TS function's own documented fallback. IMMUTABLE + PARALLEL SAFE:
-- required for use in a GENERATED STORED column, and true here (pure
-- deterministic string manipulation of its one input, no table/session
-- state).
CREATE OR REPLACE FUNCTION normalise_email_for_abuse_check(raw_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT
    CASE
      WHEN parts.local_part IS NULL OR parts.domain = '' THEN base.trimmed
      WHEN parts.domain IN ('gmail.com', 'googlemail.com') THEN
        regexp_replace(split_part(parts.local_part, '+', 1), '\.', '', 'g') || '@gmail.com'
      ELSE parts.local_part || '@' || parts.domain
    END
  FROM (SELECT lower(btrim(raw_email)) AS trimmed) base
  CROSS JOIN LATERAL (
    -- Greedy `.*` mirrors JS's `lastIndexOf('@')`: it matches as much of the
    -- local part as possible while still leaving a trailing `@[^@]*$` to
    -- match, i.e. it splits on the LAST `@`, not the first.
    SELECT
      substring(base.trimmed from '^(.*)@[^@]*$') AS local_part,
      substring(base.trimmed from '@([^@]*)$') AS domain
  ) parts;
$fn$;

COMMENT ON FUNCTION normalise_email_for_abuse_check(text) IS 'SQL mirror of @sl/shared''s normaliseEmailForAbuseCheck() (packages/shared/src/email-normalise.ts) — lower/trim + gmail dot/plus canonicalisation, for trial-abuse matching only. Backs users.email_normalised; keep the two in lockstep if the TS function ever changes.';

ALTER TABLE users ADD COLUMN email_normalised text GENERATED ALWAYS AS (normalise_email_for_abuse_check(email::text)) STORED;

-- Not unique: this is a matching key for abuse detection, not an identity —
-- many live users are expected to normalise to the same value only when
-- they are, in fact, abusing the trial system, which is exactly the
-- condition the query using this index is checking for.
CREATE INDEX users_email_normalised_idx ON users (email_normalised) WHERE deleted_at IS NULL;

COMMENT ON COLUMN users.email_normalised IS 'Generated (STORED) from email via normalise_email_for_abuse_check(); Postgres keeps it in sync automatically on every INSERT/UPDATE of email, so no application code path owns "refreshing" it. Used only for trial-abuse matching (docs/05-subscriptions.md §5, check 1) — never for login/uniqueness, which stays on the citext email column.';
