-- CreateTable
CREATE TABLE "channel_installations" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "bot_user_id" TEXT,
    "credentials" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_installations_provider_external_id_key" ON "channel_installations"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_installations_integration_id_provider_key" ON "channel_installations"("integration_id", "provider");

-- AddForeignKey
ALTER TABLE "channel_installations" ADD CONSTRAINT "channel_installations_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_installations" ADD CONSTRAINT "channel_installations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
