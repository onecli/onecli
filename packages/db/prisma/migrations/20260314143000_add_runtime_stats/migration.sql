CREATE TABLE "RuntimeEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "intercept" BOOLEAN NOT NULL DEFAULT true,
  "injectionCount" INTEGER NOT NULL DEFAULT 0,
  "statusCode" INTEGER,
  "durationMs" INTEGER NOT NULL,
  "cacheHit" BOOLEAN NOT NULL DEFAULT false,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RuntimeEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RuntimeStatBucket" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "bucketGranularity" TEXT NOT NULL DEFAULT 'hour',
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "injectedRequests" INTEGER NOT NULL DEFAULT 0,
  "injectionCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "cacheHitCount" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "minDurationMs" INTEGER NOT NULL DEFAULT 0,
  "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
  "lastActivityAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RuntimeStatBucket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RuntimeEvent_userId_createdAt_idx" ON "RuntimeEvent"("userId", "createdAt");
CREATE INDEX "RuntimeEvent_agentId_createdAt_idx" ON "RuntimeEvent"("agentId", "createdAt");
CREATE INDEX "RuntimeEvent_host_createdAt_idx" ON "RuntimeEvent"("host", "createdAt");
CREATE UNIQUE INDEX "RuntimeStatBucket_userId_bucketStart_bucketGranularity_key" ON "RuntimeStatBucket"("userId", "bucketStart", "bucketGranularity");
CREATE INDEX "RuntimeStatBucket_userId_bucketStart_idx" ON "RuntimeStatBucket"("userId", "bucketStart");

ALTER TABLE "RuntimeEvent"
  ADD CONSTRAINT "RuntimeEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeEvent"
  ADD CONSTRAINT "RuntimeEvent_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuntimeStatBucket"
  ADD CONSTRAINT "RuntimeStatBucket_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
