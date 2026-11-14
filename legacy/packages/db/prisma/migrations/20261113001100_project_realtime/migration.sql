CREATE TABLE "ProjectRealtime" (
  "projectId" TEXT PRIMARY KEY REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "version" BIGINT NOT NULL DEFAULT 0
);

CREATE FUNCTION notify_devsync_project_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_project TEXT;
BEGIN
  IF TG_TABLE_NAME = 'TaskComment' THEN
    SELECT "projectId" INTO changed_project FROM "Task"
      WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."taskId" ELSE NEW."taskId" END;
  ELSIF TG_OP = 'DELETE' THEN
    changed_project := OLD."projectId";
  ELSE
    changed_project := NEW."projectId";
  END IF;

  INSERT INTO "ProjectRealtime" ("projectId", "version")
    SELECT "id", 1 FROM "Project" WHERE "id" = changed_project
    ON CONFLICT ("projectId") DO UPDATE SET "version" = "ProjectRealtime"."version" + 1;
  RETURN NULL;
END;
$$;

INSERT INTO "ProjectRealtime" ("projectId") SELECT "id" FROM "Project";

CREATE TRIGGER "comment_project_change" AFTER INSERT OR UPDATE OR DELETE ON "TaskComment"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "task_project_change" AFTER INSERT OR UPDATE OR DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "signal_project_change" AFTER INSERT OR UPDATE OR DELETE ON "Signal"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "member_project_change" AFTER INSERT OR UPDATE OR DELETE ON "ProjectMember"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "audit_project_change" AFTER INSERT OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "agent_project_change" AFTER INSERT OR DELETE ON "Agent"
  FOR EACH ROW EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "agent_status_project_change" AFTER UPDATE ON "Agent"
  FOR EACH ROW WHEN (
    OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt" OR
    OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" OR
    OLD."name" IS DISTINCT FROM NEW."name" OR
    (NEW."lastHeartbeat" IS NOT NULL AND (
      OLD."lastHeartbeat" IS NULL OR NEW."lastHeartbeat" - OLD."lastHeartbeat" > INTERVAL '2 minutes'
    ))
  ) EXECUTE FUNCTION notify_devsync_project_change();
CREATE TRIGGER "task_activity_project_change" AFTER INSERT ON "OutboxEvent"
  FOR EACH ROW WHEN (NEW."taskId" IS NOT NULL) EXECUTE FUNCTION notify_devsync_project_change();
