CREATE TABLE "devsync"."question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"asker_user_id" uuid,
	"asker_agent_id" uuid,
	"request_id" uuid,
	"text" text NOT NULL,
	"wait" boolean DEFAULT false NOT NULL,
	"answer" text,
	"answerer_user_id" uuid,
	"answerer_agent_id" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_project_id_asker_agent_id_request_id_unique" UNIQUE("project_id","asker_agent_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "devsync"."task" ADD COLUMN "blocked_by_question" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devsync"."question" ADD CONSTRAINT "question_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_task_id_created_at_index" ON "devsync"."question" USING btree ("task_id","created_at");