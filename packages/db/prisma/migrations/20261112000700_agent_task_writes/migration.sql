ALTER TABLE "Task" ALTER COLUMN "creatorId" DROP NOT NULL;
ALTER TABLE "Task" ADD COLUMN "creatorAgentId" TEXT, ADD COLUMN "createRequestId" TEXT;
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_creatorAgentId_fkey"
  FOREIGN KEY ("projectId", "creatorAgentId") REFERENCES "Agent"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_one_creator" CHECK (
  num_nonnulls("creatorId", "creatorAgentId") = 1
  AND ("creatorAgentId" IS NULL) = ("createRequestId" IS NULL)
);
CREATE UNIQUE INDEX "Task_projectId_creatorAgentId_createRequestId_key" ON "Task"("projectId", "creatorAgentId", "createRequestId");

ALTER TABLE "OutboxEvent" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "OutboxEvent" ADD COLUMN "actorAgentId" TEXT;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_projectId_actorAgentId_fkey"
  FOREIGN KEY ("projectId", "actorAgentId") REFERENCES "Agent"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_one_actor" CHECK (num_nonnulls("actorId", "actorAgentId") = 1);
