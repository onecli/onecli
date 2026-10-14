-- Requeue Slack cleanup jobs stuck on `missing_uninstall_credentials`.
--
-- An app the user created by hand (the paste floor) never gave the platform
-- its client id and secret, so `apps.uninstall` cannot run for it. Before the
-- cleanup worker learned to release such a job, detaching one left it
-- `blocked` forever, and the blocked row reserved the app id against
-- re-attaching the user's own app (a 409 on every attempt).
--
-- Data only, idempotent, and never releases anything by itself: it hands each
-- stuck job back to the worker, which releases a user-created app's job and
-- re-blocks every other one with the same reason (a platform-created app that
-- simply lacks a bot token keeps its confirmed-uninstall gate). Rows past
-- their retention deadline are left alone: their credentials are already
-- erased, so nothing can tell a user-created app apart any more.
UPDATE channel_cleanups
SET state = 'pending',
    reason = NULL,
    next_attempt_at = (now() AT TIME ZONE 'UTC'),
    claim_token = NULL,
    claim_expires_at = NULL,
    updated_at = (now() AT TIME ZONE 'UTC')
WHERE provider = 'slack'
  AND state = 'blocked'
  AND stage = 'uninstall'
  AND reason = 'missing_uninstall_credentials'
  AND credentials IS NOT NULL
  AND expires_at > (now() AT TIME ZONE 'UTC');
