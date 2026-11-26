import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, outboxEvent, pullRequest, run, signal } from "./db";
import { authenticateAgent } from "./domain/agents";
import { approveRun, requestRun } from "./domain/runs";
import { createTask, updateTask } from "./domain/tasks";
import type { ProjectRef } from "./host";
import { jobs } from "./jobs";
import { devsyncAgent, hostAgent } from "./test/helpers";
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
  const { id } = await hostAgent(host, project, { name: "Codex", kind: "CODEX" });
  return { host, project, owner, agentId: id };
}

describe("jobs", () => {
  it("names DevSync's five queues with their schedules and retries", () => {
    expect(Object.keys(jobs).sort()).toEqual([
      "devsync.agents-move",
      "devsync.github",
      "devsync.outbox",
      "devsync.retention",
      "devsync.runs",
    ]);
    expect(jobs["devsync.outbox"].cron).toBe("* * * * *");
    expect(jobs["devsync.outbox"].retryLimit).toBeGreaterThan(0);
    expect("cron" in jobs["devsync.github"]).toBe(false);
    expect(jobs["devsync.github"].retryLimit).toBeGreaterThan(0);
    expect(jobs["devsync.runs"].cron).toBe("*/10 * * * *");
    expect(jobs["devsync.runs"].retryLimit).toBeGreaterThan(0);
    expect(jobs["devsync.agents-move"].cron).toBe("0 * * * *");
    expect(jobs["devsync.agents-move"].retryLimit).toBeGreaterThan(0);
    expect(jobs["devsync.retention"].retryLimit).toBeGreaterThan(0);
  });
});

describe("devsync.agents-move", () => {
  it("moves DevSync's own agents to the host on its schedule, once", async () => {
    const { host, project, agentId } = await setup();
    const own = await devsyncAgent(host, project, { name: "Own", kind: "CLAUDE" });

    await jobs["devsync.agents-move"].handler({}, host);
    await jobs["devsync.agents-move"].handler(null, host);
    expect(host.agents.adopted.map((call) => call.agents.map((a) => a.agentId))).toEqual([
      [own.id],
    ]);
    expect((await testDb.db.select().from(agent)).map((a) => [a.id, a.tokenHash]).sort()).toEqual(
      [
        [agentId, null],
        [own.id, null],
      ].sort(),
    );
    expect((await authenticateAgent(host, own.token)).agentId).toBe(own.id);
    expect(host.errors).toEqual([]);
  });

  it("refuses a payload that isn't the schedule's", async () => {
    const { host } = await setup();
    await expect(jobs["devsync.agents-move"].handler("now", host)).rejects.toThrow(
      "DevSync's devsync.agents-move job has an invalid payload: payload.",
    );
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

describe("devsync.runs", () => {
  it("dispatches an approved run, sweeps on its schedule, and refuses half a payload", async () => {
    const { host, project, owner } = await setup();
    const ctx = { project, member: owner };
    const created = await createTask(host, ctx, {
      title: "Add a health check",
      description: "",
      acceptanceCriteria: "",
    });
    await updateTask(host, ctx, created.id, { version: created.version, status: "READY" });
    const asked = await requestRun(host, ctx, created.id);
    await approveRun(host, ctx, asked.id);

    await expect(jobs["devsync.runs"].handler({ runId: asked.id }, host)).rejects.toThrow(
      "DevSync's devsync.runs job has an invalid payload: runId.",
    );
    await expect(
      jobs["devsync.runs"].handler({ projectId: project.projectId, runId: "nope" }, host),
    ).rejects.toThrow("DevSync's devsync.runs job has an invalid payload: runId.");
    // The schedule's empty payloads sweep: this run waited less than ten minutes.
    await jobs["devsync.runs"].handler(null, host);
    await jobs["devsync.runs"].handler({}, host);
    expect(host.github.dispatches).toEqual([]);

    await jobs["devsync.runs"].handler({ projectId: project.projectId, runId: asked.id }, host);
    expect(host.github.dispatches.map((d) => d.inputs.run_id)).toEqual([asked.id]);
    const [row] = await testDb.db.select().from(run).where(eq(run.id, asked.id));
    expect(row?.status).toBe("RUNNING");
  });
});

describe("devsync.retention", () => {
  it("deletes the signals acknowledged over 30 days ago, daily, and keeps every other", async () => {
    const { host, project, agentId } = await setup();
    const { id: peerId } = await hostAgent(host, project, { name: "Claude", kind: "CLAUDE" });
    const now = Date.parse(FAKE_NOW);
    const day = 24 * 60 * 60 * 1000;
    const scope = { workspaceId: project.workspaceId, projectId: project.projectId };
    /** A signal to `recipient`, acknowledged `ackedDaysAgo` days ago (null: not yet). */
    const add = async (
      ackedDaysAgo: number | null,
      fields: { recipient?: string; sender?: string; replyToId?: string; hopCount?: number } = {},
    ) => {
      const [row] = await testDb.db
        .insert(signal)
        .values({
          ...scope,
          recipientAgentId: fields.recipient ?? agentId,
          senderAgentId: fields.sender ?? null,
          replyToId: fields.replyToId ?? null,
          hopCount: fields.hopCount ?? 0,
          kind: "system.warning",
          payload: { message: "Hi" },
          idempotencyKey: crypto.randomUUID(),
          createdAt: new Date(now - 40 * day),
          acknowledgedAt: ackedDaysAgo === null ? null : new Date(now - ackedDaysAgo * day),
        })
        .returning({ id: signal.id });
      if (!row) throw new Error("no signal");
      return row.id;
    };
    const old = await add(31);
    const recent = await add(29);
    const pending = await add(null);
    // An old conversation goes whole; one whose last reply is still pending stays whole, since
    // deleting a signal deletes its replies.
    const chain = [await add(35, { recipient: peerId, sender: agentId })];
    for (let hop = 1; hop <= 4; hop++) {
      const to = hop % 2 === 1 ? agentId : peerId;
      const from = hop % 2 === 1 ? peerId : agentId;
      chain.push(
        await add(32, { recipient: to, sender: from, replyToId: chain.at(-1), hopCount: hop }),
      );
    }
    const kept = [await add(40, { recipient: peerId, sender: agentId })];
    kept.push(await add(35, { sender: peerId, replyToId: kept[0], hopCount: 1 }));
    kept.push(
      await add(null, { recipient: peerId, sender: agentId, replyToId: kept[1], hopCount: 2 }),
    );

    await jobs["devsync.retention"].handler({}, host);
    await jobs["devsync.retention"].handler(null, host);
    const left = (await testDb.db.select({ id: signal.id }).from(signal)).map((s) => s.id);
    expect(left.sort()).toEqual([recent, pending, ...kept].sort());
    expect(left).not.toContain(old);
    for (const id of chain) expect(left).not.toContain(id);
    expect(host.errors).toEqual([]);
  });

  it("runs daily and refuses a payload that isn't the schedule's", async () => {
    const { host } = await setup();
    expect(jobs["devsync.retention"].cron).toBe("0 3 * * *");
    await expect(jobs["devsync.retention"].handler("now", host)).rejects.toThrow(
      "DevSync's devsync.retention job has an invalid payload: payload.",
    );
  });
});
