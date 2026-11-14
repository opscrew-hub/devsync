ALTER TABLE "GithubRepository" ADD COLUMN "snapshot" JSONB;
CREATE FUNCTION clear_devsync_github_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."snapshot" := NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "clear_snapshot_on_repository_change" BEFORE UPDATE ON "GithubRepository"
  FOR EACH ROW WHEN (OLD."repositoryId" IS DISTINCT FROM NEW."repositoryId" OR OLD."installationId" IS DISTINCT FROM NEW."installationId")
  EXECUTE FUNCTION clear_devsync_github_snapshot();
