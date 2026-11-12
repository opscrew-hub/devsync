ALTER TABLE "OutboxEvent" ADD COLUMN "reviewRequestId" TEXT;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_reviewRequestId_fkey"
  FOREIGN KEY ("reviewRequestId") REFERENCES "OutboxEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "OutboxEvent_reviewRequestId_key" ON "OutboxEvent"("reviewRequestId");
