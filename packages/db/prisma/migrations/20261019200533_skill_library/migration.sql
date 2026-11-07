-- CreateTable
CREATE TABLE "skill_sources" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "account" TEXT,
    "account_type" TEXT,
    "app_connection_id" TEXT,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "head_sha" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "access_lost" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" TEXT,
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_skills" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "plugin" TEXT,
    "commit_sha" TEXT NOT NULL,
    "skipped" JSONB,
    "last_error" TEXT,
    "sync_bytes" INTEGER NOT NULL,
    "manifest_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_skill_files" (
    "id" TEXT NOT NULL,
    "library_skill_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "library_skill_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_library_skills" (
    "agent_id" TEXT NOT NULL,
    "library_skill_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_library_skills_pkey" PRIMARY KEY ("agent_id","library_skill_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_sources_organization_id_key" ON "skill_sources"("organization_id");

-- CreateIndex
CREATE INDEX "skill_sources_last_checked_at_idx" ON "skill_sources"("last_checked_at");

-- CreateIndex
CREATE UNIQUE INDEX "library_skills_source_id_name_key" ON "library_skills"("source_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "library_skill_files_library_skill_id_path_key" ON "library_skill_files"("library_skill_id", "path");

-- CreateIndex
CREATE INDEX "agent_library_skills_library_skill_id_idx" ON "agent_library_skills"("library_skill_id");

-- AddForeignKey
ALTER TABLE "skill_sources" ADD CONSTRAINT "skill_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_sources" ADD CONSTRAINT "skill_sources_app_connection_id_fkey" FOREIGN KEY ("app_connection_id") REFERENCES "app_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_skills" ADD CONSTRAINT "library_skills_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "skill_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_skill_files" ADD CONSTRAINT "library_skill_files_library_skill_id_fkey" FOREIGN KEY ("library_skill_id") REFERENCES "library_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_library_skills" ADD CONSTRAINT "agent_library_skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_library_skills" ADD CONSTRAINT "agent_library_skills_library_skill_id_fkey" FOREIGN KEY ("library_skill_id") REFERENCES "library_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
