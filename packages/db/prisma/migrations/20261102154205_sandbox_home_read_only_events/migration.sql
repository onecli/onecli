-- CreateTable
CREATE TABLE "sandbox_home_read_only_events" (
    "id" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "node" TEXT,
    "hold_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_home_read_only_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandbox_home_read_only_events_sandbox_id_created_at_idx" ON "sandbox_home_read_only_events"("sandbox_id", "created_at");

-- CreateIndex
CREATE INDEX "sandbox_home_read_only_events_created_at_idx" ON "sandbox_home_read_only_events"("created_at");

-- AddForeignKey
ALTER TABLE "sandbox_home_read_only_events" ADD CONSTRAINT "sandbox_home_read_only_events_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
