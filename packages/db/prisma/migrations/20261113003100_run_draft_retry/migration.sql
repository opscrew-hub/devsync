ALTER TABLE "AgentRun"
  ADD COLUMN "draftRepositoryId" BIGINT,
  ADD COLUMN "draftInstallationId" BIGINT,
  ADD COLUMN "draftRetryAt" TIMESTAMP(3);
CREATE INDEX "AgentRun_draftRetryAt_idx" ON "AgentRun" ("draftRetryAt");
