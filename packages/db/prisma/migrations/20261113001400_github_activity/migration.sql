CREATE FUNCTION notify_devsync_github_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ProjectRealtime" ("projectId", "version")
    SELECT "projectId", 1 FROM "GithubRepository"
    WHERE "installationId" = NEW."installationId" AND "repositoryId" = NEW."repositoryId"
    ON CONFLICT ("projectId") DO UPDATE SET "version" = "ProjectRealtime"."version" + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "github_project_change" AFTER UPDATE OF "processedAt" ON "GithubEvent"
  FOR EACH ROW WHEN (OLD."processedAt" IS NULL AND NEW."processedAt" IS NOT NULL)
  EXECUTE FUNCTION notify_devsync_github_activity();
