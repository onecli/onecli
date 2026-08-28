-- Rename the tenancy layer: project -> workspace (and the sandbox disk
-- concept: workspace_* -> home_*, freeing the word).
--
-- Everything is an in-place RENAME (the 20260427000001 accounts->projects
-- precedent): no table is dropped or recreated, every row survives, and the
-- final names are byte-identical to what `prisma migrate diff --from-empty
-- --to-schema-datamodel` generates for the renamed schema, so the CI drift
-- gate stays green.
--
-- Stored VALUES are rewritten where the platform compares them ('project'
-- scope literals, audit service names, audit metadata.scope). Deliberately
-- NOT rewritten:
--   * request_logs.extra_data (highest-volume table): the single reader
--     (request-log-service.getMatchedRuleScope) normalizes 'project' ->
--     'workspace' instead. That normalizer is load-bearing — it is what makes
--     skipping this backfill correct.
--   * user-authored JSON (policy_rules_v2.conditions, onboarding survey
--     blobs): user data, not platform vocabulary.
--   * app_connections.metadata.quotaProjectId — Google Cloud's own vocabulary,
--     read at request time to set x-goog-user-project. Never rewrite it.
--
-- OPERATIONS: every rename below is metadata-only, but they all take
-- ACCESS EXCLUSIVE locks and Prisma wraps the file in ONE transaction, so the
-- locks are held together until commit and they block reads as well as writes.
-- lock_timeout makes that fail fast and roll back cleanly rather than queue
-- behind a long-running reader (a BI dashboard query, an old app task) and
-- stall every subsequent query behind the waiting DDL. Retry the migration
-- rather than letting it block the database. See the cutover procedure in
-- plans/v2-todo.md — this migration is NOT safe inside a rolling deploy.
SET LOCAL lock_timeout = '5s';

-- ── 1. Drop the two CHECKs that compare scope literals (re-added in §7 with
--       the new column names and the new 'workspace' literal) ──────────────
ALTER TABLE "policy_rules_v2" DROP CONSTRAINT "policy_rules_v2_scope_shape";
ALTER TABLE "skills" DROP CONSTRAINT "skills_scope_coherent";

-- ── 2. Tables ───────────────────────────────────────────────────────────────
ALTER TABLE "projects" RENAME TO "workspaces";
ALTER TABLE "project_access" RENAME TO "workspace_access";

-- ── 3. Columns ──────────────────────────────────────────────────────────────
-- The 13 tenancy columns:
ALTER TABLE "agents" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "api_keys" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "app_configs" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "app_connections" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "audit_logs" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "budgets" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "onboarding_surveys" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "policy_rules_v2" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "request_logs" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "secrets" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "skills" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "vault_connections" RENAME COLUMN "project_id" TO "workspace_id";
ALTER TABLE "workspace_access" RENAME COLUMN "project_id" TO "workspace_id";
-- The 4 sandbox disk ("home") columns:
ALTER TABLE "sandboxes" RENAME COLUMN "workspace_ref" TO "home_ref";
ALTER TABLE "sandboxes" RENAME COLUMN "workspace_desired_generation" TO "home_desired_generation";
ALTER TABLE "sandboxes" RENAME COLUMN "workspace_applied_generation" TO "home_applied_generation";
ALTER TABLE "sandboxes" RENAME COLUMN "workspace_sync_claimed_at" TO "home_sync_claimed_at";

-- ── 4. Constraints (17 FKs, 2 PKs, 1 CHECK — renames only, no re-validation) ─
ALTER TABLE "agents" RENAME CONSTRAINT "agents_project_id_fkey" TO "agents_workspace_id_fkey";
ALTER TABLE "api_keys" RENAME CONSTRAINT "api_keys_project_id_fkey" TO "api_keys_workspace_id_fkey";
ALTER TABLE "app_configs" RENAME CONSTRAINT "app_configs_project_id_fkey" TO "app_configs_workspace_id_fkey";
ALTER TABLE "app_connections" RENAME CONSTRAINT "app_connections_project_id_fkey" TO "app_connections_workspace_id_fkey";
ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_project_id_fkey" TO "audit_logs_workspace_id_fkey";
ALTER TABLE "budgets" RENAME CONSTRAINT "budgets_project_id_fkey" TO "budgets_workspace_id_fkey";
ALTER TABLE "onboarding_surveys" RENAME CONSTRAINT "onboarding_surveys_project_id_fkey" TO "onboarding_surveys_workspace_id_fkey";
ALTER TABLE "policy_rules_v2" RENAME CONSTRAINT "policy_rules_v2_project_id_fkey" TO "policy_rules_v2_workspace_id_fkey";
ALTER TABLE "secrets" RENAME CONSTRAINT "secrets_project_id_fkey" TO "secrets_workspace_id_fkey";
ALTER TABLE "skills" RENAME CONSTRAINT "skills_project_id_fkey" TO "skills_workspace_id_fkey";
ALTER TABLE "vault_connections" RENAME CONSTRAINT "vault_connections_project_id_fkey" TO "vault_connections_workspace_id_fkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_project_id_fkey" TO "workspace_access_workspace_id_fkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_user_id_fkey" TO "workspace_access_user_id_fkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_group_id_fkey" TO "workspace_access_group_id_fkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_created_by_user_id_fkey" TO "workspace_access_created_by_user_id_fkey";
ALTER TABLE "workspaces" RENAME CONSTRAINT "projects_created_by_user_id_fkey" TO "workspaces_created_by_user_id_fkey";
ALTER TABLE "workspaces" RENAME CONSTRAINT "projects_organization_id_fkey" TO "workspaces_organization_id_fkey";
ALTER TABLE "workspaces" RENAME CONSTRAINT "projects_pkey" TO "workspaces_pkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_pkey" TO "workspace_access_pkey";
ALTER TABLE "workspace_access" RENAME CONSTRAINT "project_access_one_principal" TO "workspace_access_one_principal";

-- ── 5. Indexes (19; the 63-char policy index truncates differently) ─────────
ALTER INDEX "agents_project_id_identifier_key" RENAME TO "agents_workspace_id_identifier_key";
ALTER INDEX "agents_project_id_idx" RENAME TO "agents_workspace_id_idx";
ALTER INDEX "api_keys_project_id_idx" RENAME TO "api_keys_workspace_id_idx";
ALTER INDEX "app_configs_project_id_provider_key" RENAME TO "app_configs_workspace_id_provider_key";
ALTER INDEX "app_connections_project_id_provider_idx" RENAME TO "app_connections_workspace_id_provider_idx";
ALTER INDEX "audit_logs_project_id_created_at_idx" RENAME TO "audit_logs_workspace_id_created_at_idx";
ALTER INDEX "onboarding_surveys_project_id_key" RENAME TO "onboarding_surveys_workspace_id_key";
ALTER INDEX "policy_rules_v2_project_id_idx" RENAME TO "policy_rules_v2_workspace_id_idx";
ALTER INDEX "policy_rules_v2_scope_organization_id_project_id_status_pri_idx" RENAME TO "policy_rules_v2_scope_organization_id_workspace_id_status_p_idx";
ALTER INDEX "project_access_group_id_idx" RENAME TO "workspace_access_group_id_idx";
ALTER INDEX "project_access_project_id_group_id_key" RENAME TO "workspace_access_workspace_id_group_id_key";
ALTER INDEX "project_access_project_id_user_id_key" RENAME TO "workspace_access_workspace_id_user_id_key";
ALTER INDEX "project_access_user_id_idx" RENAME TO "workspace_access_user_id_idx";
ALTER INDEX "projects_organization_id_idx" RENAME TO "workspaces_organization_id_idx";
ALTER INDEX "projects_organization_id_slug_key" RENAME TO "workspaces_organization_id_slug_key";
ALTER INDEX "request_logs_project_id_created_at_idx" RENAME TO "request_logs_workspace_id_created_at_idx";
ALTER INDEX "secrets_project_id_idx" RENAME TO "secrets_workspace_id_idx";
ALTER INDEX "skills_project_id_name_key" RENAME TO "skills_workspace_id_name_key";
ALTER INDEX "vault_connections_project_id_provider_key" RENAME TO "vault_connections_workspace_id_provider_key";

-- ── 6. Scope defaults + stored values ───────────────────────────────────────
ALTER TABLE "api_keys" ALTER COLUMN "scope" SET DEFAULT 'workspace';
ALTER TABLE "secrets" ALTER COLUMN "scope" SET DEFAULT 'workspace';
ALTER TABLE "app_connections" ALTER COLUMN "scope" SET DEFAULT 'workspace';
ALTER TABLE "app_configs" ALTER COLUMN "scope" SET DEFAULT 'workspace';

UPDATE "api_keys" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "secrets" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "app_connections" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "app_configs" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "policy_rules_v2" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "skills" SET "scope" = 'workspace' WHERE "scope" = 'project';
UPDATE "policy_rule_targets" SET "app_connection_scope" = 'workspace' WHERE "app_connection_scope" = 'project';
UPDATE "policy_rule_targets" SET "secret_scope" = 'workspace' WHERE "secret_scope" = 'project';
UPDATE "audit_logs" SET "service" = 'workspace' WHERE "service" = 'project';
UPDATE "audit_logs" SET "metadata" = jsonb_set("metadata"::jsonb, '{scope}', '"workspace"')
  WHERE "metadata"::jsonb ->> 'scope' = 'project';

-- ── 7. Re-add the literal-comparing CHECKs under their original names ───────
ALTER TABLE "policy_rules_v2" ADD CONSTRAINT "policy_rules_v2_scope_shape" CHECK (
  ("scope" = 'organization' AND "organization_id" IS NOT NULL AND "workspace_id" IS NULL) OR
  ("scope" = 'workspace' AND "workspace_id" IS NOT NULL AND "organization_id" IS NULL)
);
ALTER TABLE "skills" ADD CONSTRAINT "skills_scope_coherent" CHECK (
  (("scope" = 'agent') = ("agent_id" IS NOT NULL)) AND
  (("scope" = 'workspace') = ("workspace_id" IS NOT NULL)) AND
  (("scope" = 'organization') = ("organization_id" IS NOT NULL))
);
