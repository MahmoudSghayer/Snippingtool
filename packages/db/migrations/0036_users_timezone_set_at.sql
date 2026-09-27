-- 0036_users_timezone_set_at.sql
--
-- `users.timezone_set_at`: when the trader (or an admin) last chose
-- `users.timezone` explicitly. `timezone` defaults to 'UTC', so the value
-- alone can't tell a trader who chose UTC from one who never chose; the
-- dashboard defaults an unset zone to the browser's and must keep a chosen
-- UTC as UTC. Set by PATCH /users/me and the admin user edit whenever a
-- timezone is sent; registration leaves it NULL.
--
-- ADD COLUMN with no default is metadata-only (no table rewrite).
ALTER TABLE users ADD COLUMN timezone_set_at timestamptz;

-- A zone other than the default was set deliberately. A stored 'UTC' stays
-- ambiguous and reads as "not set", which is how it behaved before this.
UPDATE users SET timezone_set_at = updated_at WHERE timezone <> 'UTC';

COMMENT ON COLUMN users.timezone_set_at IS
  'When the trader (or an admin) last chose users.timezone explicitly; NULL = still the signup default.';
