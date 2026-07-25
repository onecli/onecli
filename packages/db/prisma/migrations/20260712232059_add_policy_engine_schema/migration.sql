-- CreateTable
CREATE TABLE "policy_rules_v2" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "organization_id" TEXT,
    "project_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "action" TEXT NOT NULL,
    "rate_limit" INTEGER,
    "rate_limit_window" TEXT,
    "require_approval" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_rules_v2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_rule_identities" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "agent_group_id" TEXT,
    "user_id" TEXT,
    "group_id" TEXT,

    CONSTRAINT "policy_rule_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_rule_targets" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "app_provider" TEXT,
    "app_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "app_connection_id" TEXT,
    "secret_id" TEXT,
    "host_pattern" TEXT,
    "path_pattern" TEXT,
    "method" TEXT,

    CONSTRAINT "policy_rule_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_rules_v2_scope_organization_id_project_id_status_pri_idx" ON "policy_rules_v2"("scope", "organization_id", "project_id", "status", "priority");

-- CreateIndex
CREATE INDEX "policy_rules_v2_organization_id_idx" ON "policy_rules_v2"("organization_id");

-- CreateIndex
CREATE INDEX "policy_rules_v2_project_id_idx" ON "policy_rules_v2"("project_id");

-- CreateIndex
CREATE INDEX "policy_rule_identities_agent_id_idx" ON "policy_rule_identities"("agent_id");

-- CreateIndex
CREATE INDEX "policy_rule_identities_agent_group_id_idx" ON "policy_rule_identities"("agent_group_id");

-- CreateIndex
CREATE INDEX "policy_rule_identities_user_id_idx" ON "policy_rule_identities"("user_id");

-- CreateIndex
CREATE INDEX "policy_rule_identities_group_id_idx" ON "policy_rule_identities"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_identities_rule_id_agent_id_key" ON "policy_rule_identities"("rule_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_identities_rule_id_agent_group_id_key" ON "policy_rule_identities"("rule_id", "agent_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_identities_rule_id_user_id_key" ON "policy_rule_identities"("rule_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_identities_rule_id_group_id_key" ON "policy_rule_identities"("rule_id", "group_id");

-- CreateIndex
CREATE INDEX "policy_rule_targets_rule_id_idx" ON "policy_rule_targets"("rule_id");

-- CreateIndex
CREATE INDEX "policy_rule_targets_app_connection_id_idx" ON "policy_rule_targets"("app_connection_id");

-- CreateIndex
CREATE INDEX "policy_rule_targets_secret_id_idx" ON "policy_rule_targets"("secret_id");

-- CreateIndex
CREATE INDEX "policy_rule_targets_app_provider_idx" ON "policy_rule_targets"("app_provider");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_targets_rule_id_app_connection_id_key" ON "policy_rule_targets"("rule_id", "app_connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_targets_rule_id_secret_id_key" ON "policy_rule_targets"("rule_id", "secret_id");

-- AddForeignKey
ALTER TABLE "policy_rules_v2" ADD CONSTRAINT "policy_rules_v2_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules_v2" ADD CONSTRAINT "policy_rules_v2_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules_v2" ADD CONSTRAINT "policy_rules_v2_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "policy_rules_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "policy_rules_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_app_connection_id_fkey" FOREIGN KEY ("app_connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-appended (Prisma has no native CHECK support): a rule is scoped to exactly
-- one of org/project matching its `scope`; each identity row names exactly one
-- principal; each target row's populated columns match its `kind`. See plans/policy-engine.md §2.2.
ALTER TABLE "policy_rules_v2" ADD CONSTRAINT "policy_rules_v2_scope_shape" CHECK (
    (scope = 'organization' AND "organization_id" IS NOT NULL AND "project_id" IS NULL)
    OR (scope = 'project' AND "project_id" IS NOT NULL AND "organization_id" IS NULL)
);
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_one_principal" CHECK (num_nonnulls("agent_id", "agent_group_id", "user_id", "group_id") = 1);
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_kind_shape" CHECK (
    (kind = 'app' AND "app_provider" IS NOT NULL AND "app_connection_id" IS NULL AND "secret_id" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'connection' AND "app_connection_id" IS NOT NULL AND "app_provider" IS NULL AND "secret_id" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'secret' AND "secret_id" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'network' AND "host_pattern" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "secret_id" IS NULL)
);
