CREATE TRIGGER "run_created_or_deleted_project_change" AFTER INSERT OR DELETE ON "AgentRun"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();

CREATE TRIGGER "run_status_project_change" AFTER UPDATE OF "status" ON "AgentRun"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION notify_devsync_project_change();
