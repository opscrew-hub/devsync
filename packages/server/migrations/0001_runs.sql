CREATE INDEX "run_task_id_created_at_index" ON "devsync"."run" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_unended_task_index" ON "devsync"."run" USING btree ("task_id") WHERE "devsync"."run"."status" in ('REQUESTED', 'QUEUED', 'RUNNING');--> statement-breakpoint
ALTER TABLE "devsync"."run" DROP COLUMN "base_commit";--> statement-breakpoint
ALTER TABLE "devsync"."run" ADD CONSTRAINT "run_project_id_github_run_id_unique" UNIQUE("project_id","github_run_id");