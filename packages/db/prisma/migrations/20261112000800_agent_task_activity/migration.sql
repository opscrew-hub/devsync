CREATE UNIQUE INDEX "Task_projectId_id_key" ON "Task"("projectId", "id");

ALTER TABLE "OutboxEvent"
  ADD COLUMN "taskId" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD CONSTRAINT "OutboxEvent_projectId_taskId_fkey"
    FOREIGN KEY ("projectId", "taskId") REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "OutboxEvent_projectId_actorAgentId_requestId_key" ON "OutboxEvent"("projectId", "actorAgentId", "requestId");
CREATE INDEX "OutboxEvent_projectId_taskId_createdAt_idx" ON "OutboxEvent"("projectId", "taskId", "createdAt");
