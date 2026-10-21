-- 0041_user_gallery.sql
--
-- Nova AI's Gallery mode list (the cards for FC's Gallery Sets, each card's
-- progress, the fut.gg Sets on it, the Sets marked completed and when, the
-- budget), per account instead of per browser:
-- `GET`/`PUT /api/v1/extension/gallery` read and replace it, so a browser
-- the trader signs in on (another PC, a cloud machine, after signing out
-- and back in) shows which Sets are done and which are not. The extension
-- keeps a local copy for when the API cannot be reached.
--
-- Its own table, not a key in `user_settings.settings`, for the same
-- reasons as user_recent_searches (0037) and user_bot_settings (0039): the
-- settings PUT rebuilds that document from its known sections, snapshots
-- every change into `settings_history` and bumps the sync `version`. The
-- list changes after every card the bot buys and needs none of that.
CREATE TABLE user_gallery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  state         jsonb NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  -- The API validates the list (@sl/shared galleryStateSchema); the DB only
  -- holds it to its shape.
  CONSTRAINT user_gallery_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

CREATE TRIGGER trg_user_gallery_set_updated_at
  BEFORE UPDATE ON user_gallery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_gallery_bump_row_version
  BEFORE UPDATE ON user_gallery
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_gallery TO app_rw;
GRANT SELECT ON user_gallery TO app_ro;

COMMENT ON TABLE user_gallery IS 'Nova AI''s Gallery mode list (cards and their progress, fut.gg Sets, completed Sets and when), replaced whole by PUT /extension/gallery. One row per user (CASCADE on delete), created on the first save.';
