ALTER TABLE "Signal" ALTER COLUMN "senderId" DROP NOT NULL;
ALTER TABLE "Signal"
  ADD COLUMN "senderAgentId" TEXT,
  ADD COLUMN "replyToId" TEXT,
  ADD COLUMN "hopCount" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Signal_projectId_senderAgentId_fkey" FOREIGN KEY ("projectId", "senderAgentId") REFERENCES "Agent"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Signal_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Signal_single_sender" CHECK (num_nonnulls("senderId", "senderAgentId") = 1),
  ADD CONSTRAINT "Signal_hop_range" CHECK ("hopCount" BETWEEN 0 AND 4);
CREATE UNIQUE INDEX "Signal_projectId_senderAgentId_idempotencyKey_key" ON "Signal"("projectId", "senderAgentId", "idempotencyKey");
CREATE UNIQUE INDEX "Signal_replyToId_key" ON "Signal"("replyToId");
CREATE INDEX "Signal_projectId_senderAgentId_createdAt_idx" ON "Signal"("projectId", "senderAgentId", "createdAt");
