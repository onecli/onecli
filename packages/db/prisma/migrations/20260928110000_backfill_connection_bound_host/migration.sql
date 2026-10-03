-- Backfill `metadata.bound_host` for host-bound connections created before the
-- API began writing it (connection-service `withBoundHost`). One key for every
-- provider whose credential is injected only on one stored tenant host, so the
-- dashboard, the agent's "Connected apps" list and the gateway's wrong-host
-- answer all read the same value.
--
-- Data only, idempotent, and never widens injection: the gateway decides
-- injection on the ENCRYPTED credential field, never on this key; this value
-- is only ever shown to the user and the agent. Sourced from each provider's
-- existing non-secret copy of the host, and written only when that copy is a
-- bare hostname inside the provider's own zone. Anything else is left unset
-- (the agent then sees no host, and a reconnect records it).

-- Salesforce: `metadata.instance_host` (the org's My Domain).
UPDATE app_connections
SET metadata = metadata || jsonb_build_object('bound_host', lower(metadata->>'instance_host'))
WHERE provider = 'salesforce'
  AND NOT (metadata ? 'bound_host')
  AND lower(metadata->>'instance_host') ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+my\.salesforce\.com$';

-- Snowflake: `metadata.url` (`https://<org>-<account>.snowflakecomputing.com`).
UPDATE app_connections
SET metadata = metadata || jsonb_build_object(
  'bound_host', substring(lower(metadata->>'url') from '^https://([a-z0-9.-]+)$')
)
WHERE provider = 'snowflake'
  AND NOT (metadata ? 'bound_host')
  AND lower(metadata->>'url') ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+snowflakecomputing\.com$';

-- JFrog: `metadata.name` echoes the host the user typed (`<name>.jfrog.io`).
UPDATE app_connections
SET metadata = metadata || jsonb_build_object('bound_host', lower(metadata->>'name'))
WHERE provider = 'jfrog-artifactory'
  AND NOT (metadata ? 'bound_host')
  AND lower(metadata->>'name') ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+jfrog\.io$';
