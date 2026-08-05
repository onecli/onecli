-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "app_availability_mode" TEXT NOT NULL DEFAULT 'open';

-- CreateTable
CREATE TABLE "app_availability_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT,
    "providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_availability_rule_identities" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "user_id" TEXT,
    "group_id" TEXT,

    CONSTRAINT "app_availability_rule_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_availability_rules_organization_id_idx" ON "app_availability_rules"("organization_id");

-- CreateIndex
CREATE INDEX "app_availability_rule_identities_rule_id_idx" ON "app_availability_rule_identities"("rule_id");

-- CreateIndex
CREATE INDEX "app_availability_rule_identities_user_id_idx" ON "app_availability_rule_identities"("user_id");

-- CreateIndex
CREATE INDEX "app_availability_rule_identities_group_id_idx" ON "app_availability_rule_identities"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_availability_rule_identities_rule_id_user_id_key" ON "app_availability_rule_identities"("rule_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_availability_rule_identities_rule_id_group_id_key" ON "app_availability_rule_identities"("rule_id", "group_id");

-- AddForeignKey
ALTER TABLE "app_availability_rules" ADD CONSTRAINT "app_availability_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_availability_rules" ADD CONSTRAINT "app_availability_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_availability_rule_identities" ADD CONSTRAINT "app_availability_rule_identities_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "app_availability_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_availability_rule_identities" ADD CONSTRAINT "app_availability_rule_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_availability_rule_identities" ADD CONSTRAINT "app_availability_rule_identities_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-appended (Prisma has no native CHECK support): every identity row names
-- exactly ONE principal (user | group). The app layer enforces the same
-- invariant; this is the DB backstop. Mirrors policy_rule_identities.
ALTER TABLE "app_availability_rule_identities" ADD CONSTRAINT "app_availability_rule_identities_one_principal" CHECK (num_nonnulls("user_id", "group_id") = 1);
