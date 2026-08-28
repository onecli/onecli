-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "workspace_applied_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "workspace_desired_generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "workspace_sync_claimed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "agent_id" TEXT,
    "project_id" TEXT,
    "organization_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT,
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_files" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skills_agent_id_name_key" ON "skills"("agent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "skills_project_id_name_key" ON "skills"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "skills_organization_id_name_key" ON "skills"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "skill_files_skill_id_path_key" ON "skill_files"("skill_id", "path");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-appended (Prisma cannot express these) ──────────────────────────────
-- Exactly one owner column per row (the ProjectAccess one-principal idiom).
-- Fresh table — nothing existing to violate.
ALTER TABLE "skills"
  ADD CONSTRAINT "skills_one_owner"
  CHECK (num_nonnulls("agent_id", "project_id", "organization_id") = 1);

-- scope names the set column and nothing else may (the coherence-equality
-- idiom ×3, same family as agent_memory_revisions_restore_coherent).
ALTER TABLE "skills"
  ADD CONSTRAINT "skills_scope_coherent"
  CHECK (
    (("scope" = 'agent') = ("agent_id" IS NOT NULL))
    AND (("scope" = 'project') = ("project_id" IS NOT NULL))
    AND (("scope" = 'organization') = ("organization_id" IS NOT NULL))
  );
