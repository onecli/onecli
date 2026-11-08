-- Retire the "OneCLI users only" channel setting (`members_only`, and its
-- pre-rename spellings `denied` / `revoked`). A channel now answers everyone
-- in it (`approved`) or stays silent (`blocked`).
--
-- Space rows move to `approved` ("Anyone here"): workspace members were
-- already answered there, and the channel is now open to the rest of the
-- room, which is the setting the owner keeps choosing in practice.
UPDATE "agent_reach_grants"
   SET "state" = 'approved',
       "updated_at" = CURRENT_TIMESTAMP,
       "revision" = "revision" + 1
 WHERE "subject_kind" = 'space'
   AND "state" IN ('members_only', 'denied', 'revoked');

-- Person rows were always read as "not allowed" in these states; make that
-- explicit so only the two live settlements remain.
UPDATE "agent_reach_grants"
   SET "state" = 'blocked',
       "updated_at" = CURRENT_TIMESTAMP,
       "revision" = "revision" + 1
 WHERE "subject_kind" = 'external_user'
   AND "state" IN ('members_only', 'denied', 'revoked');

-- One shape for a person's name, whichever path first saw them: the DM
-- knock used to store "@Dana" while an outbound send stored "Sam". Person
-- labels are plain names now; drop the one leading "@".
UPDATE "agent_reach_grants"
   SET "subject_label" = substr("subject_label", 2),
       "revision" = "revision" + 1
 WHERE "subject_kind" = 'external_user'
   AND "subject_label" LIKE '@%'
   AND length("subject_label") > 1;
