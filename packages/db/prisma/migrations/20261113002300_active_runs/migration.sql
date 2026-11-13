DROP INDEX "AgentRun_one_pending_task";
CREATE UNIQUE INDEX "AgentRun_one_pending_task" ON "AgentRun"("taskId") WHERE "status" IN ('REQUESTED', 'QUEUED', 'RUNNING');
