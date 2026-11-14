ALTER TABLE "Task" ADD COLUMN "pullRequestNumber" INTEGER;
ALTER TABLE "Task" ADD CONSTRAINT "Task_positive_pull_request" CHECK ("pullRequestNumber" > 0);

CREATE FUNCTION clear_devsync_pull_request_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Task" SET "pullRequestNumber" = NULL, "version" = "version" + 1, "updatedAt" = timezone('UTC', clock_timestamp())
    WHERE "projectId" = OLD."projectId" AND "pullRequestNumber" IS NOT NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "clear_links_on_repository_change" AFTER UPDATE ON "GithubRepository"
  FOR EACH ROW WHEN (OLD."repositoryId" IS DISTINCT FROM NEW."repositoryId" OR OLD."installationId" IS DISTINCT FROM NEW."installationId")
  EXECUTE FUNCTION clear_devsync_pull_request_links();
CREATE TRIGGER "clear_links_on_repository_delete" AFTER DELETE ON "GithubRepository"
  FOR EACH ROW EXECUTE FUNCTION clear_devsync_pull_request_links();
