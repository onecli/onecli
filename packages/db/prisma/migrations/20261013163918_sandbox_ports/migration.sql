-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "listening_ports" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "sandbox_ports" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "expires_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "approval_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_ports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_ports_slug_key" ON "sandbox_ports"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_ports_agent_id_port_key" ON "sandbox_ports"("agent_id", "port");

-- AddForeignKey
ALTER TABLE "sandbox_ports" ADD CONSTRAINT "sandbox_ports_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_ports" ADD CONSTRAINT "sandbox_ports_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
