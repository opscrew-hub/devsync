CREATE TABLE "GithubEvent" (
  "deliveryId" TEXT PRIMARY KEY,
  "event" TEXT NOT NULL,
  "installationId" BIGINT NOT NULL,
  "repositoryId" BIGINT NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3)
);
CREATE INDEX "GithubEvent_processedAt_receivedAt_idx" ON "GithubEvent"("processedAt", "receivedAt");
CREATE INDEX "GithubEvent_installationId_repositoryId_receivedAt_idx"
  ON "GithubEvent"("installationId", "repositoryId", "receivedAt");
