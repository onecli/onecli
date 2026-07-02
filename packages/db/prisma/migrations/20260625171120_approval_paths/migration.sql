-- CreateTable
CREATE TABLE "approval_paths" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'project',
    "project_id" TEXT,
    "organization_id" TEXT,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB,
    "credentials" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_paths_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_paths_scope_idx" ON "approval_paths"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "approval_paths_project_id_channel_key" ON "approval_paths"("project_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "approval_paths_organization_id_channel_key" ON "approval_paths"("organization_id", "channel");

-- AddForeignKey
ALTER TABLE "approval_paths" ADD CONSTRAINT "approval_paths_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_paths" ADD CONSTRAINT "approval_paths_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
