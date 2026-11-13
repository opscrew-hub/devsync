CREATE TABLE "GithubRepository" (
  "projectId" TEXT PRIMARY KEY REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "installationId" BIGINT NOT NULL,
  "repositoryId" BIGINT NOT NULL,
  "fullName" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("installationId", "repositoryId")
);
