-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "secretMode" TEXT NOT NULL DEFAULT 'all';

-- CreateTable
CREATE TABLE "AgentSecret" (
    "agentId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,

    CONSTRAINT "AgentSecret_pkey" PRIMARY KEY ("agentId","secretId")
);

-- AddForeignKey
ALTER TABLE "AgentSecret" ADD CONSTRAINT "AgentSecret_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSecret" ADD CONSTRAINT "AgentSecret_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;
