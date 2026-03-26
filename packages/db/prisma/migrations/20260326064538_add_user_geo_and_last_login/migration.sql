-- Add country_code, country, last_login_at to users table
-- Recreate table to maintain correct column order:
-- identity → geo → activity → timestamps

-- 1. Drop all foreign keys referencing users
ALTER TABLE "account_members" DROP CONSTRAINT "account_members_user_id_fkey";
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_created_by_user_id_fkey";
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_created_by_user_id_fkey";
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_updated_by_user_id_fkey";
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_fkey";
ALTER TABLE "onboarding_surveys" DROP CONSTRAINT "onboarding_surveys_user_id_fkey";

-- 2. Create new table with desired column order
CREATE TABLE "users_new" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "external_auth_id" TEXT NOT NULL,
    "country_code" TEXT,
    "country" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_new_pkey" PRIMARY KEY ("id")
);

-- 3. Copy data
INSERT INTO "users_new" ("id", "email", "name", "external_auth_id", "created_at", "updated_at")
SELECT "id", "email", "name", "external_auth_id", "created_at", "updated_at"
FROM "users";

-- 4. Drop old table, rename new table, rename PK constraint
DROP TABLE "users";
ALTER TABLE "users_new" RENAME TO "users";
ALTER INDEX "users_new_pkey" RENAME TO "users_pkey";

-- 5. Recreate indexes
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_external_auth_id_key" ON "users"("external_auth_id");

-- 6. Restore foreign keys
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
