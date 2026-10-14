-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "source_connection_id" TEXT;

-- CreateIndex
CREATE INDEX "app_connections_source_connection_id_idx" ON "app_connections"("source_connection_id");

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
