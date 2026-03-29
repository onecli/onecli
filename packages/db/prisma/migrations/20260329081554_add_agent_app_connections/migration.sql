-- CreateTable
CREATE TABLE "agent_app_connections" (
    "agent_id" TEXT NOT NULL,
    "app_connection_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_app_connections_pkey" PRIMARY KEY ("agent_id","app_connection_id")
);

-- AddForeignKey
ALTER TABLE "agent_app_connections" ADD CONSTRAINT "agent_app_connections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_app_connections" ADD CONSTRAINT "agent_app_connections_app_connection_id_fkey" FOREIGN KEY ("app_connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
