-- ONE setting per person: the reach row (`agent_reach_grants`, subject_kind
-- `external_user`) now decides both directions of a direct message:
--   approved = Always allow: they may DM the agent, it answers and may
--              message them
--   blocked  = Never: neither
-- The outbound address book (`agent_contacts`) stops deciding anything. Fold
-- its standing decisions into the reach rows, so no owner choice is lost: a
-- block in either place wins, then an allow. The next migration drops the
-- table.

-- 1. A contact the owner BLOCKED: the person becomes Never.
UPDATE "agent_reach_grants" g
   SET "state" = 'blocked',
       "decided_by_user_id" = COALESCE(c."decided_by_user_id", g."decided_by_user_id"),
       "decided_at" = COALESCE(g."decided_at", CURRENT_TIMESTAMP),
       "updated_at" = CURRENT_TIMESTAMP,
       "revision" = g."revision" + 1
  FROM "agent_contacts" c
 WHERE c."agent_id" = g."agent_id"
   AND c."kind" = 'person'
   AND c."external_ref" = g."external_ref"
   AND g."subject_kind" = 'external_user'
   AND c."policy" = 'blocked'
   AND g."state" <> 'blocked';

-- 2. A contact the owner ALLOWED, whose person row is undecided (pending or
--    parked): Always allow. An explicit blocked row is left alone (a block
--    wins).
UPDATE "agent_reach_grants" g
   SET "state" = 'approved',
       "decided_by_user_id" = COALESCE(c."decided_by_user_id", g."decided_by_user_id"),
       "decided_at" = COALESCE(g."decided_at", CURRENT_TIMESTAMP),
       "updated_at" = CURRENT_TIMESTAMP,
       "revision" = g."revision" + 1
  FROM "agent_contacts" c
 WHERE c."agent_id" = g."agent_id"
   AND c."kind" = 'person'
   AND c."external_ref" = g."external_ref"
   AND g."subject_kind" = 'external_user'
   AND c."policy" = 'allow'
   AND g."state" IN ('pending', 'expired', 'left');

-- 3. A decided contact with NO person row yet (someone the agent messaged
--    who never DM'd it): create the row, on the agent's channel presence for
--    the same provider. `ask` contacts need no row: no row already means
--    the agent's first message to them asks the owner about them.
INSERT INTO "agent_reach_grants" (
  "id", "agent_id", "integration_id", "provider", "subject_kind",
  "external_ref", "subject_label", "state", "listen", "card_refs",
  "decided_by_user_id", "decided_at", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, c."agent_id", p."integration_id", p."provider",
       'external_user', c."external_ref", c."display_name",
       CASE c."policy" WHEN 'allow' THEN 'approved' ELSE 'blocked' END,
       'mentions', '[]'::jsonb,
       c."decided_by_user_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "agent_contacts" c
  JOIN "agent_channels" p ON p."agent_id" = c."agent_id"
 WHERE c."kind" = 'person'
   AND c."policy" IN ('allow', 'blocked')
   AND NOT EXISTS (
     SELECT 1 FROM "agent_reach_grants" g
      WHERE g."agent_id" = c."agent_id"
        AND g."subject_kind" = 'external_user'
        AND g."external_ref" = c."external_ref"
   )
ON CONFLICT DO NOTHING;

-- 4. A CHANNEL contact the owner BLOCKED ("never post here"): the channel's
--    one setting is its reach row now, and a block in either place wins, so
--    the channel becomes Never. A channel with no reach row needs nothing:
--    the agent's first post there asks the owner.
UPDATE "agent_reach_grants" g
   SET "state" = 'blocked',
       "listen" = 'mentions',
       "decided_by_user_id" = COALESCE(c."decided_by_user_id", g."decided_by_user_id"),
       "decided_at" = COALESCE(g."decided_at", CURRENT_TIMESTAMP),
       "updated_at" = CURRENT_TIMESTAMP,
       "revision" = g."revision" + 1
  FROM "agent_contacts" c
 WHERE c."agent_id" = g."agent_id"
   AND c."kind" = 'channel'
   AND c."external_ref" = g."external_ref"
   AND g."subject_kind" = 'space'
   AND c."policy" = 'blocked'
   AND g."state" <> 'blocked';

-- `agent_links` needs nothing: a side still on `ask` already means "no
-- answer yet", and its first message now asks once, about the pair.
