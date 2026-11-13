ALTER TABLE "AgentRun" ADD COLUMN "dispatchToken" TEXT,
  ADD COLUMN "dispatchExpiresAt" TIMESTAMP(3);
CREATE INDEX "AgentRun_dispatch_queue_idx" ON "AgentRun"("createdAt", "id") WHERE "status" = 'QUEUED';
