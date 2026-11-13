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
  const { createProject } = await import("@devsync/core");
  const { linkGithubRepository, getGithubRepository } = await import("@devsync/core/github-app");
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
    assert.equal((await getGithubRepository(owner, project.id))?.fullName, "fixture/repo");
    await assert.rejects(getGithubRepository(randomUUID(), project.id), /not found/);
    assert.ok(!JSON.stringify(saved).includes("fixture-token"));
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});
