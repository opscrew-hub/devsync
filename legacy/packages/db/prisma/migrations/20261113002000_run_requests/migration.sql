CREATE TYPE "RunStatus" AS ENUM ('REQUESTED', 'QUEUED', 'REJECTED', 'CANCELLED');
CREATE TABLE "AgentRun" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL REFERENCES "User"("id"),
  "decidedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "revision" INTEGER NOT NULL,
  "agentType" "AgentType" NOT NULL,
  "status" "RunStatus" NOT NULL DEFAULT 'REQUESTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  FOREIGN KEY ("projectId", "taskId") REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentRun_projectId_createdAt_idx" ON "AgentRun"("projectId", "createdAt");
CREATE UNIQUE INDEX "AgentRun_one_pending_task" ON "AgentRun"("taskId") WHERE "status" IN ('REQUESTED', 'QUEUED');
