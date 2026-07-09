-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "app_config_id" TEXT;

-- CreateIndex
CREATE INDEX "app_connections_app_config_id_idx" ON "app_connections"("app_config_id");

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_app_config_id_fkey" FOREIGN KEY ("app_config_id") REFERENCES "app_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
