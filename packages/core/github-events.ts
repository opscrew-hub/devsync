import { db } from "@devsync/db";
import { requireProject } from "./index.ts";

export async function processGithubEvent() {
  return db.$executeRaw`
    WITH pending AS (
      SELECT event.*, repo."projectId" FROM "GithubEvent" event
      JOIN "GithubRepository" repo USING ("installationId", "repositoryId")
      WHERE event."processedAt" IS NULL
      ORDER BY event."receivedAt", event."deliveryId"
      LIMIT 1 FOR UPDATE OF event SKIP LOCKED
    ), classified AS (
      SELECT pending.*, CASE
        WHEN "event" = 'push' AND "payload"->>'ref' LIKE 'refs/heads/%' THEN 'git.branch_updated'
        WHEN "event" = 'pull_request' AND "payload"->>'action' = 'opened' THEN 'git.pr_opened'
        WHEN "event" = 'pull_request' AND "payload"->>'action' = 'closed'
          AND "payload"#>>'{pull_request,merged}' = 'true' THEN 'git.pr_merged'
      END AS kind FROM pending
    ), delivered AS (
      INSERT INTO "Signal" ("id", "projectId", "recipientId", "githubDeliveryId", "kind", "payload", "idempotencyKey")
      SELECT gen_random_uuid()::text, event."projectId", agent."id", event."deliveryId", event.kind,
        jsonb_strip_nulls(jsonb_build_object(
          'message', CASE event.kind
            WHEN 'git.branch_updated' THEN 'GitHub branch updated'
            WHEN 'git.pr_opened' THEN 'GitHub pull request opened'
            WHEN 'git.pr_merged' THEN 'GitHub pull request merged'
          END,
          'ref', left(event."payload"->>'ref', 512),
          'sha', left(COALESCE(event."payload"->>'after', event."payload"#>>'{pull_request,head,sha}'), 64),
          'pullRequestNumber', event."payload"#>'{pull_request,number}',
          'repositoryId', event."repositoryId"::text,
          'deliveryId', event."deliveryId"
        )), 'github:' || event."deliveryId"
      FROM classified event JOIN "Agent" agent ON agent."projectId" = event."projectId"
      WHERE event.kind IS NOT NULL AND agent."revokedAt" IS NULL
        AND agent."createdAt" <= event."receivedAt"
      ON CONFLICT ("githubDeliveryId", "recipientId") DO NOTHING
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

export async function listGithubState(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return db.$queryRaw<{ event: string; key: string; label: string | null; state: string }[]>`
    SELECT "event", "key", "label", "state"
    FROM (
      SELECT state.*, row_number() OVER (PARTITION BY state."event" ORDER BY state."receivedAt" DESC, state."key") AS position
      FROM "GithubRepository" repo JOIN "GithubObservedState" state USING ("installationId", "repositoryId")
      WHERE repo."projectId" = ${projectId} AND state."state" <> 'deleted'
    ) items WHERE position <= 10
    ORDER BY "event", position
  `;
}
