-- AlterTable
ALTER TABLE "app_configs" ADD COLUMN     "partner_id" TEXT;

-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "partner_id" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "partner_detached_at" TIMESTAMP(3),
ADD COLUMN     "partner_id" TEXT;

-- AlterTable
ALTER TABLE "policy_rules" ADD COLUMN     "partner_id" TEXT;

-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "partner_id" TEXT;

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_members" (
    "partner_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_members_pkey" PRIMARY KEY ("partner_id","user_id")
);

-- CreateTable
CREATE TABLE "partner_claims" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "placeholder_user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "claimed_by_user_id" TEXT,
    "claimed_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_slug_key" ON "partners"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "partners_api_key_key" ON "partners"("api_key");

-- CreateIndex
CREATE INDEX "partner_members_user_id_idx" ON "partner_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_claims_organization_id_key" ON "partner_claims"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_claims_placeholder_user_id_key" ON "partner_claims"("placeholder_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_claims_token_key" ON "partner_claims"("token");

-- CreateIndex
CREATE INDEX "partner_claims_token_idx" ON "partner_claims"("token");

-- CreateIndex
CREATE INDEX "partner_claims_partner_id_idx" ON "partner_claims"("partner_id");

-- CreateIndex
CREATE INDEX "partner_claims_status_idx" ON "partner_claims"("status");

-- CreateIndex
CREATE INDEX "app_configs_partner_id_idx" ON "app_configs"("partner_id");

-- CreateIndex
CREATE INDEX "app_connections_partner_id_idx" ON "app_connections"("partner_id");

-- CreateIndex
CREATE INDEX "organizations_partner_id_idx" ON "organizations"("partner_id");

-- CreateIndex
CREATE INDEX "policy_rules_partner_id_idx" ON "policy_rules"("partner_id");

-- CreateIndex
CREATE INDEX "secrets_partner_id_idx" ON "secrets"("partner_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_claims" ADD CONSTRAINT "partner_claims_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_claims" ADD CONSTRAINT "partner_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_claims" ADD CONSTRAINT "partner_claims_placeholder_user_id_fkey" FOREIGN KEY ("placeholder_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
