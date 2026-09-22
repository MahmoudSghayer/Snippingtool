-- 0016_notifications.sql

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type            text NOT NULL,
  title           text NOT NULL,
  body            text,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,

  read_at         timestamptz,
  delivered_via   notification_channel NOT NULL DEFAULT 'in_app',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 0,

  CONSTRAINT notifications_data_is_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX notifications_user_id_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_type_idx ON notifications (type);

CREATE TRIGGER trg_notifications_set_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notifications_bump_row_version
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO app_rw;
GRANT SELECT ON notifications TO app_ro;

COMMENT ON TABLE notifications IS 'In-app/email/push/WS notifications to a user (subscription changed, force logout, license issue, etc.). Pure child of users: CASCADE on user delete.';
COMMENT ON COLUMN notifications.type IS 'Machine-readable notification type, e.g. "subscription.past_due", "device.new_login".';
COMMENT ON COLUMN notifications.delivered_via IS 'Channel this notification was (or will be) delivered through.';
