-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "harness" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'byo',
ADD COLUMN     "model" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "byo_legacy" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "runners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'instance',
    "capabilities" JSONB,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "runner_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unprovisioned',
    "container_ref" TEXT,
    "workspace_ref" TEXT,
    "last_active_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runners_token_key" ON "runners"("token");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_agent_id_key" ON "sandboxes"("agent_id");

-- CreateIndex
CREATE INDEX "sandboxes_runner_id_idx" ON "sandboxes"("runner_id");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
