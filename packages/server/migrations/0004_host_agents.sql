ALTER TABLE "devsync"."agent" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devsync"."agent" ALTER COLUMN "expires_at" DROP NOT NULL;