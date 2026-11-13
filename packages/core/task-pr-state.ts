import { db } from "@devsync/db";
import { requireProject } from "./index.ts";

export async function getTaskPullRequestState(userId: string, projectId: string, taskId: string) {
  await requireProject(userId, projectId);
  const [row] = await db.$queryRaw<{
    number: number; fullName: string; title: string | null; status: string | null; observedAt: Date | null;
  }[]>`
    SELECT task."pullRequestNumber" AS "number", repo."fullName", observed."label" AS "title",
      observed."state" AS "status", observed."receivedAt" AS "observedAt"
    FROM "Task" task JOIN "GithubRepository" repo ON repo."projectId" = task."projectId"
    LEFT JOIN "GithubObservedState" observed ON observed."installationId" = repo."installationId"
      AND observed."repositoryId" = repo."repositoryId" AND observed."event" = 'pull_request'
      AND observed."key" = task."pullRequestNumber"::text
    WHERE task."projectId" = ${projectId} AND task."id" = ${taskId} AND task."pullRequestNumber" IS NOT NULL
  `;
  return row ?? null;
}
