import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";

test("GitHub webhook intake verifies signatures, scopes repositories, and deduplicates deliveries", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { POST } = await import("./app/api/webhooks/github/route.ts");
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const originalRepositories = process.env.GITHUB_WEBHOOK_REPOSITORIES;
  const secret = randomUUID();
  const deliveryId = randomUUID();
  const payload = JSON.stringify({ installation: { id: 123 }, repository: { id: 456 }, ref: "refs/heads/main" });
  const request = (body: string, event = "push", signedBody = body, id: string = deliveryId) =>
    new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(signedBody).digest("hex"),
        "x-github-event": event,
        "x-github-delivery": id,
      },
      body,
    });
  try {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    assert.equal((await POST(request(payload))).status, 503);
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    process.env.GITHUB_WEBHOOK_REPOSITORIES = "123:456";
    assert.equal((await POST(request(payload + " ", "push", payload))).status, 401);
    assert.equal((await POST(request(payload, "push", payload, "invalid"))).status, 400);
    assert.equal((await POST(request("{}", "ping"))).status, 204);
    assert.equal((await POST(request("{}", "installation"))).status, 204);
    assert.equal((await POST(request("{"))).status, 400);
    assert.equal((await POST(request("[".repeat(40) + "0" + "]".repeat(40)))).status, 400);
    assert.equal((await POST(request(payload.replace("456", "457")))).status, 403);
    assert.equal((await POST(request("x".repeat(2 * 1024 * 1024 + 1)))).status, 413);
    const results = await Promise.all([POST(request(payload)), POST(request(payload))]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 202]);
    const event = await db.githubEvent.findUniqueOrThrow({ where: { deliveryId } });
    assert.equal(event.installationId, 123n);
    assert.equal(event.repositoryId, 456n);
    assert.equal(event.processedAt, null);
    assert.deepEqual(event.payload, JSON.parse(payload));
  } finally {
    if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    if (originalRepositories === undefined) delete process.env.GITHUB_WEBHOOK_REPOSITORIES;
    else process.env.GITHUB_WEBHOOK_REPOSITORIES = originalRepositories;
    await db.githubEvent.deleteMany({ where: { deliveryId } });
    await db.$disconnect();
  }
});

test("GitHub repository links require owner access and scoped verification", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { db } = await import("@devsync/db");
  const { createProject, createTask, getTask } = await import("@devsync/core");
  const { linkGithubRepository, getGithubRepository, refreshGithubSnapshot } = await import("@devsync/core/github-app");
  const owner = randomUUID();
  try {
    await db.user.create({ data: { id: owner, name: "Owner" } });
    const project = await createProject(owner, { name: "GitHub", description: "" });
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.GITHUB_PROJECT_REPOSITORIES = `${project.id}:456:789`;
    const calls: string[] = [];
    const mock: typeof fetch = async (url, init) => {
      calls.push(String(url));
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), { repository_ids: [789], permissions: { metadata: "read" } });
        assert.equal(new Headers(init.headers).get("authorization")?.split(".").length, 3);
        return Response.json({ token: "fixture-token" });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
      return Response.json({ id: 789, full_name: "fixture/repo" });
    };
    await assert.rejects(linkGithubRepository(owner, project.id, { installationId: 456, repositoryId: 790 }, mock), /not authorized/);
    assert.deepEqual(calls, []);
    const saved = await linkGithubRepository(owner, project.id, { installationId: 456, repositoryId: 789 }, mock);
    assert.equal(saved.repositoryId, "789");
    const snapshot = await refreshGithubSnapshot(owner, project.id, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)).permissions, { metadata: "read", contents: "read", pull_requests: "read", checks: "read" });
        return Response.json({ token: "fixture-token" });
      }
      if (path === "/repositories/789") return Response.json({ id: 789, full_name: "fixture/repo", default_branch: "main" });
      if (path.endsWith("/branches")) return Response.json([{ name: "main", commit: { sha: "abc123" } }]);
      if (path.endsWith("/pulls")) return Response.json([{ number: 1, title: "Before webhooks", state: "open" }]);
      assert.equal(path, "/repos/fixture/repo/commits/main/check-runs");
      return Response.json({ check_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success" }] });
    });
    assert.equal(snapshot.pulls[0].title, "Before webhooks");
    assert.deepEqual((await getGithubRepository(owner, project.id))?.snapshot, snapshot);
    assert.equal((await getGithubRepository(owner, project.id))?.fullName, "fixture/repo");
    await assert.rejects(getGithubRepository(randomUUID(), project.id), /not found/);
    assert.ok(!JSON.stringify(saved).includes("fixture-token"));
    const { processGithubEvent, getGithubDeliveryHealth, listGithubActivity, listGithubState, setTaskPullRequest } = await import("@devsync/core/github-events");
    const { readProjectRealtimeVersion } = await import("@devsync/core/project-realtime");
    const other = await createProject(owner, { name: "Other GitHub project", description: "" });
    const { registerAgent, pendingSignals } = await import("@devsync/core/agent-signals");
    const agent = await registerAgent(owner, project.id, { type: "CODEX", name: "GitHub watcher" });
    const outsider = await registerAgent(owner, other.id, { type: "CODEX", name: "Other watcher" });
    const deliveryId = randomUUID();
    const unlinkedId = randomUUID();
    try {
      await db.githubEvent.createMany({ data: [
        { deliveryId, installationId: 456n, repositoryId: 789n, event: "push", payload: { ref: "refs/heads/main" } },
        { deliveryId: unlinkedId, installationId: 457n, repositoryId: 789n, event: "push", payload: {} },
      ] });
      const before = await readProjectRealtimeVersion(owner, project.id);
      assert.deepEqual(await listGithubActivity(owner, project.id), []);
      assert.equal((await getGithubDeliveryHealth(owner, project.id)).pending, 1);
      await db.$executeRaw`ALTER TABLE "Signal" ADD CONSTRAINT "test_github_retry" CHECK ("githubDeliveryId" IS NULL) NOT VALID`;
      try {
        assert.equal(await processGithubEvent(), 1);
        const retryHealth = await getGithubDeliveryHealth(owner, project.id);
        assert.equal(retryHealth.retrying, 1);
        assert.equal(retryHealth.failures.length, 1);
        assert.equal(retryHealth.failures[0].deliveryId, deliveryId);
        assert.equal(retryHealth.failures[0].attempts, 1);
        assert.equal(retryHealth.failures[0].lastErrorCode, "23514");
        assert.deepEqual((await getGithubDeliveryHealth(owner, other.id)).failures, []);
        assert.equal(await processGithubEvent(), 0);
      } finally {
        await db.$executeRaw`ALTER TABLE "Signal" DROP CONSTRAINT "test_github_retry"`;
      }
      await db.$executeRaw`UPDATE "GithubEvent" SET "retryAt" = NULL WHERE "deliveryId" = ${deliveryId}`;
      const workers = await Promise.all([processGithubEvent(), processGithubEvent()]);
      assert.equal(workers.reduce((total, count) => total + count, 0), 1);
      const [activity] = await listGithubActivity(owner, project.id);
      assert.equal(activity.deliveryId, deliveryId);
      const health = await getGithubDeliveryHealth(owner, project.id);
      assert.equal(health.pending, 0);
      assert.deepEqual(health.failures, []);
      assert.ok(health.lastProcessed);
      assert.equal(activity.subject, "refs/heads/main");
      const signals = await pendingSignals(agent.token);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].kind, "git.branch_updated");
      assert.equal(signals[0].githubDeliveryId, deliveryId);
      assert.deepEqual(await pendingSignals(outsider.token), []);
      assert.equal(await processGithubEvent(), 0);
      assert.deepEqual(await listGithubActivity(owner, other.id), []);
      await assert.rejects(listGithubActivity(randomUUID(), project.id), /not found/);
      assert.notEqual(await readProjectRealtimeVersion(owner, project.id), before);
      assert.equal((await db.githubEvent.findUniqueOrThrow({ where: { deliveryId: unlinkedId } })).processedAt, null);
      const fixtures = [
        { event: "push", payload: { ref: "refs/heads/main", after: "abc123" } },
        { event: "push", payload: { ref: "refs/heads/old", after: "def456" } },
        { event: "push", payload: { ref: "refs/heads/old", deleted: true } },
        { event: "pull_request", payload: { pull_request: { number: 7, title: "Latest", merged: true, state: "closed", updated_at: "2026-11-13T12:00:00Z" } } },
        { event: "pull_request", payload: { pull_request: { number: 7, title: "Stale", state: "open", updated_at: "2026-11-13T11:00:00Z" } } },
        { event: "check_run", payload: { check_run: { id: 99, name: "CI", status: "in_progress" } } },
        { event: "check_run", payload: { check_run: { id: 99, name: "CI", conclusion: "success" } } },
      ];
      const rows = fixtures.map((fixture, index) => ({
        ...fixture, deliveryId: randomUUID(), installationId: 456n, repositoryId: 789n,
        receivedAt: new Date(Date.now() + index + 1000), processedAt: new Date(),
      }));
      try {
        await db.githubEvent.createMany({ data: rows });
        assert.deepEqual(await listGithubState(owner, project.id), [
          { event: "check_run", key: "99", label: "CI", state: "success" },
          { event: "pull_request", key: "7", label: "Latest", state: "merged" },
          { event: "push", key: "main", label: "abc123", state: "active" },
        ]);
        assert.deepEqual(await listGithubState(owner, other.id), []);
        const task = await createTask(owner, project.id, { title: "Link a PR", description: "", acceptanceCriteria: "" });
        const unrelated = await createTask(owner, other.id, { title: "Other", description: "", acceptanceCriteria: "" });
        await assert.rejects(setTaskPullRequest(owner, project.id, unrelated.id, { number: 7 }), /Task not found/);
        await assert.rejects(setTaskPullRequest(owner, project.id, task.id, { number: 8 }), /not been observed/);
        assert.deepEqual(await setTaskPullRequest(owner, project.id, task.id, { number: 7 }), { pullRequestNumber: 7 });
        assert.equal((await getTask(owner, project.id, task.id)).pullRequestNumber, 7);
        const { getTaskPullRequestState } = await import("@devsync/core/task-pr-state");
        const pull = await getTaskPullRequestState(owner, project.id, task.id);
        assert.equal(pull?.status, "merged");
        assert.equal(pull?.title, "Latest");
        assert.equal(await getTaskPullRequestState(owner, other.id, task.id), null);
        await assert.rejects(getTaskPullRequestState(randomUUID(), project.id, task.id), /not found/);
        await setTaskPullRequest(owner, project.id, task.id, { number: null });
        assert.equal((await getTask(owner, project.id, task.id)).pullRequestNumber, null);
        await setTaskPullRequest(owner, project.id, task.id, { number: 7 });
        await db.githubRepository.update({ where: { projectId: project.id }, data: { repositoryId: 790n } });
        assert.equal((await getTask(owner, project.id, task.id)).pullRequestNumber, null);
      } finally {
        await db.githubEvent.deleteMany({ where: { deliveryId: { in: rows.map(row => row.deliveryId) } } });
      }
    } finally {
      await db.githubEvent.deleteMany({ where: { deliveryId: { in: [deliveryId, unlinkedId] } } });
    }
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});
