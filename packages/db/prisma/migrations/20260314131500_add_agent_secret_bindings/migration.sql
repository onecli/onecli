-- Explicit agent-to-secret assignment table.
CREATE TABLE "AgentSecretBinding" (
  "agentId" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSecretBinding_pkey" PRIMARY KEY ("agentId", "secretId")
);

CREATE INDEX "AgentSecretBinding_secretId_idx" ON "AgentSecretBinding"("secretId");

ALTER TABLE "AgentSecretBinding"
  ADD CONSTRAINT "AgentSecretBinding_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentSecretBinding"
  ADD CONSTRAINT "AgentSecretBinding_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: assign all existing secrets to the default agent for each user.
INSERT INTO "AgentSecretBinding" ("agentId", "secretId", "createdAt")
SELECT a."id", s."id", CURRENT_TIMESTAMP
FROM "Agent" a
JOIN "Secret" s ON s."userId" = a."userId"
WHERE a."isDefault" = true
ON CONFLICT ("agentId", "secretId") DO NOTHING;
