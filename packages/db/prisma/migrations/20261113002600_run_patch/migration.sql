ALTER TABLE "AgentRun" ADD COLUMN "patch" TEXT CHECK (octet_length("patch") <= 524288);
