CREATE TABLE "devsync"."task_dependency" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "task_dependency_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id")
);
--> statement-breakpoint
ALTER TABLE "devsync"."outbox_event" ADD COLUMN "usage" jsonb;--> statement-breakpoint
ALTER TABLE "devsync"."task" ADD COLUMN "owns" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "devsync"."task" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "devsync"."task" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "devsync"."task_dependency" ADD CONSTRAINT "task_dependency_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."task_dependency" ADD CONSTRAINT "task_dependency_depends_on_task_id_task_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependency_depends_on_task_id_index" ON "devsync"."task_dependency" USING btree ("depends_on_task_id");