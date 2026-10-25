-- 0042_user_gallery_owned.sql
--
-- The account's collected-card catalogue for Nova AI's Gallery mode.
--
-- A card counts for FC's Gallery once it has passed through your club, so
-- Nova sends each bought card through the club and then lists it again and
-- sells it (the card does not stay). That makes "collected" impossible to
-- read back from the club later -- the card is gone -- and the per-list
-- gallery state (user_gallery, 0041) only tracks the list being worked now,
-- not a durable record. This table is that record: every card id the account
-- has clubbed. The planner merges it into `owned`, so a card here is never
-- bought a second time, however long ago it was collected, after it was sold,
-- and on whatever browser the trader signs in on.
--
-- GET/POST /api/v1/extension/gallery/owned read it and add to it.
CREATE TABLE user_gallery_owned (
  user_id       uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- EA's card id (resourceId). bigint: a holographic/special card's id can
  -- run past a 32-bit integer.
  resource_id   bigint NOT NULL,

  first_seen_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, resource_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_gallery_owned TO app_rw;
GRANT SELECT ON user_gallery_owned TO app_ro;

COMMENT ON TABLE user_gallery_owned IS 'Every card id an account has put through its club in Gallery mode (catalogued for FC''s Gallery). Durable so a card stays collected after Nova sells it again and across devices; merged into the planner''s owned set so it is never bought twice. CASCADE on user delete.';

-- Backfill from trade history so collecting already done is not lost. A card
-- is counted only when it was both bought (a trade) and is on the account's
-- Gallery list (user_gallery.state.cards): those are the cards Gallery mode
-- clubbed. Cards bought for Snipe/Bid flips (never clubbed) are not on a
-- Gallery list, so they are excluded.
INSERT INTO user_gallery_owned (user_id, resource_id)
SELECT DISTINCT t.user_id, (t.resource_id)::bigint
FROM trades t
JOIN user_gallery g ON g.user_id = t.user_id
-- Guard the array extract: a state saved by an older build can have a
-- non-array (or absent) `cards`, and jsonb_array_elements errors on a
-- scalar/object. Treat anything but an array as empty so one odd row never
-- aborts the backfill.
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(g.state -> 'cards') = 'array'
       THEN g.state -> 'cards'
       ELSE '[]'::jsonb END
) AS c
WHERE t.deleted_at IS NULL
  AND t.resource_id ~ '^[0-9]+$'
  AND (c ->> 'resourceId') ~ '^[0-9]+$'
  AND (c ->> 'resourceId')::bigint = (t.resource_id)::bigint
ON CONFLICT DO NOTHING;
