ALTER TABLE "AgentRun" ADD COLUMN "baseCommit" TEXT CHECK ("baseCommit" ~ '^[a-f0-9]{40}$');
