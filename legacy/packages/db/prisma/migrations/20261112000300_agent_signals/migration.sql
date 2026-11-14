CREATE TYPE "AgentType" AS ENUM ('CODEX', 'CLAUDE');
CREATE TABLE "Agent" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "type" "AgentType" NOT NULL,
  "credentialHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastHeartbeat" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id")
);
CREATE TABLE "Signal" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  FOREIGN KEY ("projectId", "recipientId") REFERENCES "Agent"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE ("projectId", "senderId", "idempotencyKey")
);
CREATE INDEX "Signal_projectId_recipientId_acknowledgedAt_createdAt_idx"
  ON "Signal"("projectId", "recipientId", "acknowledgedAt", "createdAt");
