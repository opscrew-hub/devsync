import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outboxEvent, pullRequest, signal } from "./db";
import { registerAgent } from "./domain/agents";
import type { ProjectRef } from "./host";
import { jobs } from "./jobs";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "./testing";

let testDb: TestDb;

// The outbox job takes every project's due events: each test has its own database.
beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  await testDb.close();
});

async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const owner = { userId: crypto.randomUUID(), name: "Owner", role: "owner" as const };
  const host = fakeHost(testDb.db, { projects: [project] });
  const { agent } = await registerAgent(
    host,
    { project, member: owner },
    { name: "Codex", kind: "CODEX" },
  );
  return { host, project, owner, agentId: agent.id };
}

describe("jobs", () => {
  it("names DevSync's two queues with their schedules and retries", () => {
    expect(Object.keys(jobs).sort()).toEqual(["devsync.github", "devsync.outbox"]);
    expect(jobs["devsync.outbox"].cron).toBe("* * * * *");
    expect(jobs["devsync.outbox"].retryLimit).toBeGreaterThan(0);
    expect("cron" in jobs["devsync.github"]).toBe(false);
    expect(jobs["devsync.github"].retryLimit).toBeGreaterThan(0);
  });
});

describe("devsync.outbox", () => {
  it("delivers every due event, past one batch, for a wake-up and for the cron", async () => {
    const { host, project, owner, agentId } = await setup();
    const at = new Date(FAKE_NOW);
    const events = (count: number) =>
      testDb.db.insert(outboxEvent).values(
        Array.from({ length: count }, (_, i) => ({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          actorUserId: owner.userId,
          kind: "task.created",
          payload: { message: `Task created: ${i}` },
          createdAt: at,
          availableAt: at,
        })),
      );
    await events(150);

    await jobs["devsync.outbox"].handler({ projectId: project.projectId }, host);
    expect(
      await testDb.db.select().from(outboxEvent).where(isNull(outboxEvent.processedAt)),
    ).toEqual([]);
    expect(
      await testDb.db.select().from(signal).where(eq(signal.recipientAgentId, agentId)),
    ).toHaveLength(150);

    await events(2);
    await jobs["devsync.outbox"].handler(null, host);
    await jobs["devsync.outbox"].handler({}, host);
    expect(
      await testDb.db.select().from(signal).where(eq(signal.recipientAgentId, agentId)),
    ).toHaveLength(152);
    expect(host.errors).toEqual([]);
  });

  it("refuses a payload that isn't a wake-up", async () => {
    const { host } = await setup();
    await expect(jobs["devsync.outbox"].handler({ projectId: "nope" }, host)).rejects.toThrow(
      "DevSync's devsync.outbox job has an invalid payload: projectId.",
    );
  });
});

describe("devsync.github", () => {
  it("applies a GitHub fact to its project", async () => {
    const { host, project, agentId } = await setup();
    await jobs["devsync.github"].handler(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        fact: {
          kind: "pull_request",
          deliveryId: crypto.randomUUID(),
          action: "opened",
          number: 3,
          title: "Fix the build",
          state: "open",
          merged: false,
          url: "https://github.com/acme/app/pull/3",
          headRef: "fix/build",
          headSha: "e".repeat(40),
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      host,
    );
    expect(
      (await testDb.db.select().from(pullRequest)).map((p) => [p.number, p.state, p.title]),
    ).toEqual([[3, "open", "Fix the build"]]);
    expect(
      (await testDb.db.select().from(signal).where(eq(signal.recipientAgentId, agentId))).map(
        (s) => s.kind,
      ),
    ).toEqual(["git.pr_opened"]);
  });

  it("refuses an invalid fact, naming its fields and not their values", async () => {
    const { host, project } = await setup();
    const refusal = jobs["devsync.github"].handler(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        fact: { kind: "pull_request", deliveryId: "d1", number: -1, url: "secret-looking-value" },
      },
      host,
    );
    await expect(refusal).rejects.toThrow(/^DevSync's devsync.github job has an invalid payload: /);
    await expect(refusal).rejects.toThrow(/fact\.number/);
    await expect(refusal).rejects.not.toThrow(/secret-looking-value/);
    await expect(
      jobs["devsync.github"].handler({ projectId: project.projectId, fact: {} }, host),
    ).rejects.toThrow(/workspaceId/);
    expect(await testDb.db.select().from(pullRequest)).toEqual([]);
  });
});
