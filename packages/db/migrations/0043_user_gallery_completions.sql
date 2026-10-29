-- 0043_user_gallery_completions.sql
--
-- The account's log of completed Gallery Sets, for Nova AI's Gallery mode.
--
-- The list itself (user_gallery, 0041) says which Sets stand completed now,
-- but it is replaced whole on every save, cleared by the page's Clear list
-- and Reset, capped at 500 completed Sets, and a Set's name goes with its
-- entry once the list is reset. "Which Sets did I finish lately, so I can
-- go and Autocomplete them in the game" needs a record that outlives all of
-- that: one row each time a Set is marked completed, with the name, grade
-- and tokens the list knew, and when. A Set undone later (the page's Undo,
-- or re-planned at another grade) keeps its row with `undone_at` set; a Set
-- completed again gets a new row.
--
-- The API appends to it from each `PUT /api/v1/extension/gallery` (a Set id
-- newly in the list's `completed`, marked undone when it leaves) and reads
-- it for `GET /api/v1/extension/gallery/completions` (the Nova AI page and
-- the dashboard's Gallery section, newest first).
CREATE TABLE user_gallery_completions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- fut.gg's id for the Set (what the list keys completed Sets by).
  set_id        bigint NOT NULL,
  -- The Set's name as the list had it when it was completed.
  set_name      text NOT NULL,
  -- The grade it was completed at (D..S); NULL when the list did not say
  -- (a Set completed before the list kept grades).
  grade         text,
  -- Gallery Tokens the Set gives up to that grade, when the list knew.
  tokens        integer,
  completed_at  timestamptz NOT NULL,
  -- Set when the Set was later undone or re-planned; NULL while it stands.
  undone_at     timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT user_gallery_completions_set_name_length CHECK (char_length(set_name) BETWEEN 1 AND 60),
  CONSTRAINT user_gallery_completions_grade_known CHECK (grade IS NULL OR grade IN ('D', 'C', 'B', 'A', 'S')),
  CONSTRAINT user_gallery_completions_tokens_range CHECK (tokens IS NULL OR tokens BETWEEN 0 AND 10000),
  -- One row per completion: a re-send of the same list logs nothing twice.
  CONSTRAINT user_gallery_completions_once UNIQUE (user_id, set_id, completed_at)
);

-- The log is read newest first, per user.
CREATE INDEX user_gallery_completions_user_completed_idx
  ON user_gallery_completions (user_id, completed_at DESC);

CREATE TRIGGER trg_user_gallery_completions_set_updated_at
  BEFORE UPDATE ON user_gallery_completions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_gallery_completions_bump_row_version
  BEFORE UPDATE ON user_gallery_completions
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_gallery_completions TO app_rw;
GRANT SELECT ON user_gallery_completions TO app_ro;

COMMENT ON TABLE user_gallery_completions IS 'Log of the Gallery Sets an account completed in Nova AI''s Gallery mode: one row per completion (set, name, grade, tokens, when), kept after the list is cleared or the Set undone (undone_at). Appended by PUT /extension/gallery, read by GET /extension/gallery/completions. CASCADE on user delete.';

-- Backfill from each account's list as it stands: every Set it marks
-- completed, at the time the list kept for it (`completedAt`, epoch ms;
-- else the list's last save), at the grade it kept (`completedGrade`, else
-- the Set entry's), named from the list's Set entry when it still holds one.
-- The array/object extracts are guarded like 0042's: a list saved by an
-- older build can lack any of these, and one odd row must never abort this.
INSERT INTO user_gallery_completions (user_id, set_id, set_name, grade, tokens, completed_at)
SELECT g.user_id,
       (c.id)::bigint,
       coalesce(left(nullif(s.entry ->> 'name', ''), 60), 'Set #' || c.id),
       CASE WHEN (g.state -> 'completedGrade' ->> c.id) IN ('D', 'C', 'B', 'A', 'S') THEN g.state -> 'completedGrade' ->> c.id
            WHEN (s.entry ->> 'grade') IN ('D', 'C', 'B', 'A', 'S') THEN s.entry ->> 'grade'
            ELSE NULL END,
       CASE WHEN (s.entry ->> 'tokens') ~ '^[0-9]{1,5}$' AND (s.entry ->> 'tokens')::int <= 10000 THEN (s.entry ->> 'tokens')::int ELSE NULL END,
       CASE WHEN (g.state -> 'completedAt' ->> c.id) ~ '^[0-9]{1,16}$'
            THEN to_timestamp((g.state -> 'completedAt' ->> c.id)::bigint / 1000.0)
            ELSE g.updated_at END
  FROM user_gallery g
 CROSS JOIN LATERAL jsonb_array_elements_text(
   CASE WHEN jsonb_typeof(g.state -> 'completed') = 'array' THEN g.state -> 'completed' ELSE '[]'::jsonb END
 ) AS c(id)
  LEFT JOIN LATERAL (
    SELECT e AS entry
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(g.state -> 'sets') = 'array' THEN g.state -> 'sets' ELSE '[]'::jsonb END
      ) e
     WHERE e ->> 'id' = c.id
     LIMIT 1
  ) s ON true
 WHERE c.id ~ '^[1-9][0-9]{0,15}$'
ON CONFLICT DO NOTHING;
