CREATE SCHEMA IF NOT EXISTS "devsync";
--> statement-breakpoint
CREATE TABLE "devsync"."agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"registered_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "devsync"."github_delivery" (
	"delivery_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_delivery_delivery_id_project_id_pk" PRIMARY KEY("delivery_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "devsync"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_id" uuid,
	"task_id" uuid,
	"request_id" uuid,
	"review_request_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_event_review_request_id_unique" UNIQUE("review_request_id"),
	CONSTRAINT "outbox_event_project_id_actor_agent_id_request_id_unique" UNIQUE("project_id","actor_agent_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "devsync"."pull_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"url" text NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_project_id_number_unique" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "devsync"."run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure" text,
	"token_usage" jsonb,
	"changed_files" jsonb,
	"base_commit" text,
	"draft_pull_request_url" text,
	"github_run_id" bigint
);
--> statement-breakpoint
CREATE TABLE "devsync"."signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"sender_user_id" uuid,
	"sender_agent_id" uuid,
	"github_delivery_id" text,
	"reply_to_id" uuid,
	"hop_count" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "signal_reply_to_id_unique" UNIQUE("reply_to_id"),
	CONSTRAINT "signal_recipient_agent_id_github_delivery_id_unique" UNIQUE("recipient_agent_id","github_delivery_id"),
	CONSTRAINT "signal_project_id_sender_user_id_idempotency_key_unique" UNIQUE("project_id","sender_user_id","idempotency_key"),
	CONSTRAINT "signal_project_id_sender_agent_id_idempotency_key_unique" UNIQUE("project_id","sender_agent_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "devsync"."task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" text NOT NULL,
	"status" text DEFAULT 'BACKLOG' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"creator_user_id" uuid,
	"creator_agent_id" uuid,
	"create_request_id" uuid,
	"assignee_user_id" uuid,
	"claim_agent_id" uuid,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone,
	"pull_request_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_project_id_creator_agent_id_create_request_id_unique" UNIQUE("project_id","creator_agent_id","create_request_id")
);
--> statement-breakpoint
CREATE TABLE "devsync"."task_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devsync"."task_revision" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" text NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_revision_task_id_number_pk" PRIMARY KEY("task_id","number")
);
--> statement-breakpoint
ALTER TABLE "devsync"."outbox_event" ADD CONSTRAINT "outbox_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."outbox_event" ADD CONSTRAINT "outbox_event_review_request_id_outbox_event_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "devsync"."outbox_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."run" ADD CONSTRAINT "run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."signal" ADD CONSTRAINT "signal_recipient_agent_id_agent_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "devsync"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."signal" ADD CONSTRAINT "signal_sender_agent_id_agent_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "devsync"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."signal" ADD CONSTRAINT "signal_reply_to_id_signal_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "devsync"."signal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."task_comment" ADD CONSTRAINT "task_comment_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devsync"."task_revision" ADD CONSTRAINT "task_revision_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "devsync"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_project_id_index" ON "devsync"."agent" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "outbox_event_processed_at_available_at_index" ON "devsync"."outbox_event" USING btree ("processed_at","available_at");--> statement-breakpoint
CREATE INDEX "outbox_event_project_id_task_id_created_at_index" ON "devsync"."outbox_event" USING btree ("project_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "run_project_id_created_at_index" ON "devsync"."run" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "signal_inbox_index" ON "devsync"."signal" USING btree ("project_id","recipient_agent_id","acknowledged_at","created_at");--> statement-breakpoint
CREATE INDEX "task_project_id_status_index" ON "devsync"."task" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "task_project_id_assignee_user_id_index" ON "devsync"."task" USING btree ("project_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "task_comment_task_id_created_at_index" ON "devsync"."task_comment" USING btree ("task_id","created_at");