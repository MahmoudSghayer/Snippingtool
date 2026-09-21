-- Down for 0026_users_row_version_exclude_billing.sql
-- Restores the blanket trigger from 0003_users.sql (bump on any UPDATE).
CREATE OR REPLACE TRIGGER trg_users_bump_row_version
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

DROP FUNCTION IF EXISTS bump_users_row_version();
