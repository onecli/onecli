-- Merge "codex" secret type into "openai".
-- The gateway now detects OAuth vs API key mode from the secret value.
UPDATE "secrets" SET "type" = 'openai' WHERE "type" = 'codex';
