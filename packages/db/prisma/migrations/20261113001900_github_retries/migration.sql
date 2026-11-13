ALTER TABLE "GithubEvent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retryAt" TIMESTAMP(3), ADD COLUMN "lastErrorCode" TEXT;
CREATE INDEX "GithubEvent_retryAt_idx" ON "GithubEvent"("retryAt") WHERE "processedAt" IS NULL;
DROP TRIGGER "github_project_change" ON "GithubEvent";
CREATE TRIGGER "github_project_change" AFTER UPDATE ON "GithubEvent"
  FOR EACH ROW WHEN (OLD."processedAt" IS DISTINCT FROM NEW."processedAt" OR OLD."attempts" IS DISTINCT FROM NEW."attempts")
  EXECUTE FUNCTION notify_devsync_github_activity();
