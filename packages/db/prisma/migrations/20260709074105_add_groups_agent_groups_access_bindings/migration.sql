-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "access_mode" TEXT NOT NULL DEFAULT 'open';

-- AlterTable
ALTER TABLE "policy_rules" ADD COLUMN     "agent_group_id" TEXT,
ADD COLUMN     "group_id" TEXT;

-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "access_mode" TEXT NOT NULL DEFAULT 'open';

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "external_id" TEXT,
    "app_mode" TEXT NOT NULL DEFAULT 'all',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "agent_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "app_mode" TEXT NOT NULL DEFAULT 'all',
    "credential_mode" TEXT NOT NULL DEFAULT 'all',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_group_members" (
    "agent_group_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_group_members_pkey" PRIMARY KEY ("agent_group_id","agent_id")
);

-- CreateTable
CREATE TABLE "project_access" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT,
    "group_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_access" (
    "id" TEXT NOT NULL,
    "secret_id" TEXT NOT NULL,
    "user_id" TEXT,
    "group_id" TEXT,
    "agent_id" TEXT,
    "agent_group_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secret_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_access" (
    "id" TEXT NOT NULL,
    "app_connection_id" TEXT NOT NULL,
    "user_id" TEXT,
    "group_id" TEXT,
    "agent_id" TEXT,
    "agent_group_id" TEXT,
    "session_policy" JSONB,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_access" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "user_id" TEXT,
    "group_id" TEXT,
    "agent_id" TEXT,
    "agent_group_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_role_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_role_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groups_organization_id_idx" ON "groups"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_organization_id_name_key" ON "groups"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "groups_organization_id_source_external_id_key" ON "groups"("organization_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE INDEX "agent_groups_organization_id_idx" ON "agent_groups"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_groups_organization_id_name_key" ON "agent_groups"("organization_id", "name");

-- CreateIndex
CREATE INDEX "agent_group_members_agent_id_idx" ON "agent_group_members"("agent_id");

-- CreateIndex
CREATE INDEX "project_access_user_id_idx" ON "project_access"("user_id");

-- CreateIndex
CREATE INDEX "project_access_group_id_idx" ON "project_access"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_access_project_id_user_id_key" ON "project_access"("project_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_access_project_id_group_id_key" ON "project_access"("project_id", "group_id");

-- CreateIndex
CREATE INDEX "secret_access_user_id_idx" ON "secret_access"("user_id");

-- CreateIndex
CREATE INDEX "secret_access_group_id_idx" ON "secret_access"("group_id");

-- CreateIndex
CREATE INDEX "secret_access_agent_id_idx" ON "secret_access"("agent_id");

-- CreateIndex
CREATE INDEX "secret_access_agent_group_id_idx" ON "secret_access"("agent_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_access_secret_id_user_id_key" ON "secret_access"("secret_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_access_secret_id_group_id_key" ON "secret_access"("secret_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_access_secret_id_agent_id_key" ON "secret_access"("secret_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_access_secret_id_agent_group_id_key" ON "secret_access"("secret_id", "agent_group_id");

-- CreateIndex
CREATE INDEX "connection_access_user_id_idx" ON "connection_access"("user_id");

-- CreateIndex
CREATE INDEX "connection_access_group_id_idx" ON "connection_access"("group_id");

-- CreateIndex
CREATE INDEX "connection_access_agent_id_idx" ON "connection_access"("agent_id");

-- CreateIndex
CREATE INDEX "connection_access_agent_group_id_idx" ON "connection_access"("agent_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_access_app_connection_id_user_id_key" ON "connection_access"("app_connection_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_access_app_connection_id_group_id_key" ON "connection_access"("app_connection_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_access_app_connection_id_agent_id_key" ON "connection_access"("app_connection_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_access_app_connection_id_agent_group_id_key" ON "connection_access"("app_connection_id", "agent_group_id");

-- CreateIndex
CREATE INDEX "app_access_user_id_idx" ON "app_access"("user_id");

-- CreateIndex
CREATE INDEX "app_access_group_id_idx" ON "app_access"("group_id");

-- CreateIndex
CREATE INDEX "app_access_agent_id_idx" ON "app_access"("agent_id");

-- CreateIndex
CREATE INDEX "app_access_agent_group_id_idx" ON "app_access"("agent_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_access_organization_id_provider_user_id_key" ON "app_access"("organization_id", "provider", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_access_organization_id_provider_group_id_key" ON "app_access"("organization_id", "provider", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_access_organization_id_provider_agent_id_key" ON "app_access"("organization_id", "provider", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_access_organization_id_provider_agent_group_id_key" ON "app_access"("organization_id", "provider", "agent_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_role_mappings_group_id_key" ON "group_role_mappings"("group_id");

-- CreateIndex
CREATE INDEX "group_role_mappings_organization_id_idx" ON "group_role_mappings"("organization_id");

-- CreateIndex
CREATE INDEX "policy_rules_group_id_idx" ON "policy_rules"("group_id");

-- CreateIndex
CREATE INDEX "policy_rules_agent_group_id_idx" ON "policy_rules"("agent_group_id");

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_group_members" ADD CONSTRAINT "agent_group_members_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_group_members" ADD CONSTRAINT "agent_group_members_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_group_members" ADD CONSTRAINT "agent_group_members_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_app_connection_id_fkey" FOREIGN KEY ("app_connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_agent_group_id_fkey" FOREIGN KEY ("agent_group_id") REFERENCES "agent_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_role_mappings" ADD CONSTRAINT "group_role_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_role_mappings" ADD CONSTRAINT "group_role_mappings_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-appended (Prisma has no native CHECK support): every access row names
-- exactly ONE principal. The app layer enforces the same invariant; these are
-- the DB backstop.
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_one_principal" CHECK (num_nonnulls("user_id", "group_id") = 1);
ALTER TABLE "secret_access" ADD CONSTRAINT "secret_access_one_principal" CHECK (num_nonnulls("user_id", "group_id", "agent_id", "agent_group_id") = 1);
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_one_principal" CHECK (num_nonnulls("user_id", "group_id", "agent_id", "agent_group_id") = 1);
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_one_principal" CHECK (num_nonnulls("user_id", "group_id", "agent_id", "agent_group_id") = 1);

-- Hand-appended: idempotent creator seed — a correctness backfill giving every
-- project an explicit human binding for its creator (created_by_user_id stays
-- NULL on the seeded rows = system write; updated_at supplied explicitly
-- because Prisma's @updatedAt is client-side). Re-run and verified before
-- access checks flip to bindings-only.
INSERT INTO "project_access" ("id", "project_id", "user_id", "created_at", "updated_at")
SELECT gen_random_uuid(), p."id", p."created_by_user_id", now(), now()
FROM "projects" p
WHERE p."created_by_user_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;
