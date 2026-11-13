import { db } from "@devsync/db";
import { requireProject } from "./index.ts";

export async function processGithubEvent() {
  return db.$executeRaw`
    WITH pending AS (
      SELECT event."deliveryId" FROM "GithubEvent" event
      JOIN "GithubRepository" repo USING ("installationId", "repositoryId")
      WHERE event."processedAt" IS NULL
      ORDER BY event."receivedAt", event."deliveryId"
      LIMIT 1 FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE "GithubEvent" event SET "processedAt" = timezone('UTC', clock_timestamp())
    FROM pending WHERE event."deliveryId" = pending."deliveryId"
  `;
}

export async function listGithubActivity(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return db.$queryRaw<{ deliveryId: string; event: string; receivedAt: Date; action: string | null; subject: string | null }[]>`
    SELECT event."deliveryId", event."event", event."receivedAt",
      left(event."payload"->>'action', 50) AS "action",
      left(CASE event."event"
        WHEN 'push' THEN event."payload"->>'ref'
        WHEN 'pull_request' THEN event."payload"#>>'{pull_request,title}'
        WHEN 'pull_request_review' THEN event."payload"#>>'{pull_request,title}'
        WHEN 'check_run' THEN event."payload"#>>'{check_run,name}'
        WHEN 'check_suite' THEN event."payload"#>>'{check_suite,conclusion}'
        WHEN 'workflow_run' THEN event."payload"#>>'{workflow_run,name}'
      END, 200) AS "subject"
    FROM "GithubRepository" repo JOIN "GithubEvent" event USING ("installationId", "repositoryId")
    WHERE repo."projectId" = ${projectId} AND event."processedAt" IS NOT NULL
    ORDER BY event."receivedAt" DESC, event."deliveryId" DESC
    LIMIT 25
  `;
}
