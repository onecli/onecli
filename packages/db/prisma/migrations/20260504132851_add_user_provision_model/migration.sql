-- CreateTable
CREATE TABLE "user_provisions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skip_onboarding" BOOLEAN NOT NULL DEFAULT true,
    "provisioned_by_id" TEXT NOT NULL,
    "provisioned_by_email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_provisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_provisions_user_id_key" ON "user_provisions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_provisions_project_id_key" ON "user_provisions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_provisions_token_key" ON "user_provisions"("token");

-- CreateIndex
CREATE INDEX "user_provisions_token_idx" ON "user_provisions"("token");

-- CreateIndex
CREATE INDEX "user_provisions_organization_id_idx" ON "user_provisions"("organization_id");

-- CreateIndex
CREATE INDEX "user_provisions_expires_at_status_idx" ON "user_provisions"("expires_at", "status");

-- AddForeignKey
ALTER TABLE "user_provisions" ADD CONSTRAINT "user_provisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_provisions" ADD CONSTRAINT "user_provisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_provisions" ADD CONSTRAINT "user_provisions_provisioned_by_id_fkey" FOREIGN KEY ("provisioned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
