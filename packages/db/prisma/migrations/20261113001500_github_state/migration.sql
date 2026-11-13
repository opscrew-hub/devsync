CREATE VIEW "GithubObservedState" AS
WITH items AS (
  SELECT "installationId", "repositoryId", "deliveryId", "receivedAt", "event",
    CASE "event"
      WHEN 'push' THEN substring("payload"->>'ref' FROM 12)
      WHEN 'pull_request' THEN "payload"#>>'{pull_request,number}'
      WHEN 'check_run' THEN "payload"#>>'{check_run,id}'
    END AS "key",
    CASE "event"
      WHEN 'push' THEN "payload"->>'after'
      WHEN 'pull_request' THEN "payload"#>>'{pull_request,title}'
      WHEN 'check_run' THEN "payload"#>>'{check_run,name}'
    END AS "label",
    CASE "event"
      WHEN 'push' THEN CASE WHEN "payload"->>'deleted' = 'true' THEN 'deleted' ELSE 'active' END
      WHEN 'pull_request' THEN CASE WHEN "payload"#>>'{pull_request,merged}' = 'true' THEN 'merged' ELSE "payload"#>>'{pull_request,state}' END
      WHEN 'check_run' THEN COALESCE("payload"#>>'{check_run,conclusion}', "payload"#>>'{check_run,status}')
    END AS "state",
    CASE "event" WHEN 'pull_request' THEN "payload"#>>'{pull_request,updated_at}' END AS "sourceTime"
  FROM "GithubEvent"
  WHERE "processedAt" IS NOT NULL AND (
    ("event" = 'push' AND "payload"->>'ref' LIKE 'refs/heads/%')
    OR "event" IN ('pull_request', 'check_run')
  )
)
SELECT DISTINCT ON ("installationId", "repositoryId", "event", "key")
  "installationId", "repositoryId", "event", "key", left("label", 200) AS "label",
  left("state", 40) AS "state", "receivedAt"
FROM items WHERE "key" IS NOT NULL AND "state" IS NOT NULL
ORDER BY "installationId", "repositoryId", "event", "key", "sourceTime" DESC NULLS LAST, "receivedAt" DESC, "deliveryId" DESC;
