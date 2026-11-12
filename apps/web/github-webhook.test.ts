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
