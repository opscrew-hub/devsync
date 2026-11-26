import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxEvent, task } from "../db";
import type { AgentActor, DevSyncEvent, Member, ProjectContext, ProjectRef } from "../host";
import { jobs } from "../jobs";
import { hostAgent, setClock } from "../test/helpers";
import {
  artifactFiles,
  createTestDb,
  FAKE_NOW,
  type FakeHost,
  fakeHost,
  type TestDb,
} from "../testing";
import { reportBlocker, reportProgress, requestReview, submitReview } from "./activity";
import { claimTask, releaseTask } from "./claims";
import { outbox } from "./outbox";
import { applyGithubFact } from "./pull-requests";
import { approveRun, requestRun } from "./runs";
import { createTask, linkPullRequest, updateTask } from "./tasks";

const at = new Date("2026-02-03T04:05:06.000Z");
const MINUTE = 60 * 1000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** The data of each of DevSync's events, by type: docs/platform.md's table, names and ids only. */
const DATA_KEYS: Record<string, string[]> = {
  "devsync.task.created": ["taskId", "status"],
  "devsync.task.updated": ["taskId", "revision"],
  "devsync.task.moved": ["taskId", "from", "to"],
  "devsync.task.done": ["taskId"],
  "devsync.task.claimed": ["taskId", "agentId"],
  "devsync.task.released": ["taskId", "agentId"],
  "devsync.review.requested": ["taskId", "agentId"],
  "devsync.review.approved": ["taskId", "reviewRequestId"],
  "devsync.review.changes_requested": ["taskId", "reviewRequestId"],
  "devsync.pr.linked": ["taskId", "number"],
  "devsync.pr.merged": ["taskId", "number"],
  "devsync.run.finished": ["taskId", "runId", "status", "failure"],
};

/** The texts a test wrote: none of them may reach an event's data. */
const TEXTS = [
  "Ship checkout",
  "Ship card checkout",
  "Card payments",
  "Pays",
  "Tests underway.",
  "Stuck on the card form.",
  "Ready for review.",
  "Rename the handler.",
  "Looks right.",
];

/**
 * A project with an owner, two agents (Codex and Claude) and another project, and a reader of the
 * events emitted since the last read, which checks each against the table and the change's
 * transaction.
 */
async function setup() {
  const project: ProjectRef = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    fullName: "acme/shop",
    readOnly: false,
  };
  const owner: Member = { userId: randomUUID(), name: "Owner", role: "owner" };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner] },
    projects: [project],
  });
  // Each reading a second after the last, so each step's events are ordered.
  let now = Date.parse(FAKE_NOW);
  host.clock = {
    now: () => {
      now += 1000;
      return new Date(now);
    },
  };
  const ctx: ProjectContext = { project, member: owner };
  const register = async (name: string): Promise<AgentActor> =>
    (await hostAgent(host, project, { name, kind: "CLAUDE" })).actor;
  const codex = await register("Codex");
  const claude = await register("Claude");
  let read = 0;
  /** The events emitted since the last call, as `[type, data]`, each checked. */
  const emitted = () => {
    const fresh = host.emitted.slice(read);
    read = host.emitted.length;
    for (const { tx, event } of fresh) checkEvent(host, project, tx, event);
    return fresh.map(({ event }) => [event.type, event.data]);
  };
  return { host, project, owner, ctx, codex, claude, emitted };
}

/** An event in the project, from a transaction, with the table's data: names and ids only. */
function checkEvent(host: FakeHost, project: ProjectRef, tx: unknown, event: DevSyncEvent) {
  expect(tx).not.toBe(host.db);
  expect(event.workspaceId).toBe(project.workspaceId);
  expect(event.projectId).toBe(project.projectId);
  expect(Object.keys(event.data).sort()).toEqual([...(DATA_KEYS[event.type] ?? ["?"])].sort());
  for (const value of Object.values(event.data)) {
    expect(value === null || ["string", "number", "boolean"].includes(typeof value)).toBe(true);
    for (const text of TEXTS) expect(String(value)).not.toContain(text);
  }
}

/** The task's version as stored now. */
async function versionOf(taskId: string): Promise<number> {
  const [row] = await testDb.db
    .select({ version: task.version })
    .from(task)
    .where(eq(task.id, taskId));
  if (!row) throw new Error("no task");
  return row.version;
}

const requirements = {
  title: "Ship checkout",
  description: "Card payments",
  acceptanceCriteria: "Pays",
};

describe("outbox.record", () => {
  it("inserts the event in the caller's transaction, due at once, with its actor", async () => {
    const { host, project } = await setup();
    const row = await testDb.db.transaction((tx) =>
      outbox.record(host, tx, {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        actor: { userId: project.workspaceId },
        kind: "task.updated",
        payload: { message: "Task moved to Ready: Ship" },
        at,
      }),
    );
    expect(row).toMatchObject({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      actorUserId: project.workspaceId,
      actorAgentId: null,
      taskId: null,
      requestId: null,
      reviewRequestId: null,
      kind: "task.updated",
      payload: { message: "Task moved to Ready: Ship" },
      createdAt: at,
      availableAt: at,
      processedAt: null,
      attempts: 0,
    });
    // An event of no task has no host event.
    expect(host.emitted).toEqual([]);
  });

  it("records nothing when the change's transaction rolls back", async () => {
    const { host, project } = await setup();
    await expect(
      testDb.db.transaction(async (tx) => {
        await outbox.record(host, tx, {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          actor: null,
          kind: "task.updated",
          payload: {},
          at,
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(
      await testDb.db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.projectId, project.projectId)),
    ).toEqual([]);
  });
});

describe("outbox.wake", () => {
  it("enqueues devsync.outbox for the project", async () => {
    const { host, project } = await setup();
    await outbox.wake(host, project.projectId);
    expect(host.enqueued).toEqual([
      { queue: "devsync.outbox", payload: { projectId: project.projectId }, options: undefined },
    ]);
  });
});

describe("DevSync's host events (docs/platform.md, Events)", () => {
  it("are emitted in the change's own transaction, so a change whose emit fails is rolled back", async () => {
    const { host, project, ctx } = await setup();
    const seen: unknown[] = [];
    const emit = host.emit;
    host.emit = async (tx, event) => {
      // The transaction given sees the change it hasn't committed yet.
      const taskId = String(event.data.taskId);
      seen.push(...(await tx.select({ id: task.id }).from(task).where(eq(task.id, taskId))));
      return emit(tx, event);
    };
    const created = await createTask(host, ctx, requirements);
    expect(seen).toEqual([{ id: created.id }]);

    host.emit = async () => {
      throw new Error("the host refused the event");
    };
    await expect(
      createTask(host, ctx, { ...requirements, title: "Ship card checkout" }),
    ).rejects.toThrow("the host refused the event");
    const saved = await testDb.db.select().from(task).where(eq(task.projectId, project.projectId));
    expect(saved.map((row) => row.title)).toEqual(["Ship checkout"]);
  });

  it("follow a task through its requirements, claims, reports and reviews to Done", async () => {
    const { host, ctx, codex, claude, emitted } = await setup();
    const created = await createTask(host, ctx, requirements);
    const taskId = created.id;
    expect(emitted()).toEqual([["devsync.task.created", { taskId, status: "BACKLOG" }]]);

    const ready = await updateTask(host, ctx, taskId, {
      version: created.version,
      title: "Ship card checkout",
      status: "READY",
    });
    expect(emitted()).toEqual([
      ["devsync.task.updated", { taskId, revision: 2 }],
      ["devsync.task.moved", { taskId, from: "BACKLOG", to: "READY" }],
    ]);
    // An assignment is no event of the table's.
    await updateTask(host, ctx, taskId, {
      version: ready.version,
      assigneeUserId: ctx.member.userId,
    });
    expect(emitted()).toEqual([]);

    const claim = { taskId, claimId: randomUUID() };
    await claimTask(host, codex, claim);
    expect(emitted()).toEqual([
      ["devsync.task.moved", { taskId, from: "READY", to: "CLAIMED" }],
      ["devsync.task.claimed", { taskId, agentId: codex.agentId }],
    ]);
    // Claiming again under the same live claim changes nothing.
    await claimTask(host, codex, claim);
    expect(emitted()).toEqual([]);
    await releaseTask(host, codex, claim);
    expect(emitted()).toEqual([
      ["devsync.task.released", { taskId, agentId: codex.agentId }],
      ["devsync.task.moved", { taskId, from: "CLAIMED", to: "READY" }],
    ]);

    await claimTask(host, codex, claim);
    emitted();
    const report = { ...claim, revision: 2, requestId: randomUUID(), message: "Tests underway." };
    await reportProgress(host, codex, report);
    await reportProgress(host, codex, report);
    expect(emitted()).toEqual([]);
    await reportBlocker(host, codex, {
      ...report,
      requestId: randomUUID(),
      message: "Stuck on the card form.",
    });
    expect(emitted()).toEqual([
      ["devsync.task.released", { taskId, agentId: codex.agentId }],
      ["devsync.task.moved", { taskId, from: "CLAIMED", to: "BLOCKED" }],
    ]);

    await updateTask(host, ctx, taskId, { version: await versionOf(taskId), status: "READY" });
    expect(emitted()).toEqual([["devsync.task.moved", { taskId, from: "BLOCKED", to: "READY" }]]);

    const askReview = async () => {
      await claimTask(host, codex, claim);
      const asked = await requestReview(host, codex, {
        ...claim,
        revision: 2,
        requestId: randomUUID(),
        message: "Ready for review.",
      });
      return asked.id;
    };
    const firstRequest = await askReview();
    expect(emitted()).toEqual([
      ["devsync.task.moved", { taskId, from: "READY", to: "CLAIMED" }],
      ["devsync.task.claimed", { taskId, agentId: codex.agentId }],
      ["devsync.review.requested", { taskId, agentId: codex.agentId }],
      ["devsync.task.moved", { taskId, from: "CLAIMED", to: "REVIEW" }],
    ]);
    const decision = { taskId, revision: 2, message: "Rename the handler." };
    await submitReview(host, claude, {
      ...decision,
      reviewRequestId: firstRequest,
      requestId: randomUUID(),
      decision: "CHANGES_REQUESTED",
    });
    expect(emitted()).toEqual([
      ["devsync.review.changes_requested", { taskId, reviewRequestId: firstRequest }],
      ["devsync.task.moved", { taskId, from: "REVIEW", to: "READY" }],
    ]);

    const secondRequest = await askReview();
    emitted();
    await submitReview(host, claude, {
      ...decision,
      message: "Looks right.",
      reviewRequestId: secondRequest,
      requestId: randomUUID(),
      decision: "APPROVED",
    });
    expect(emitted()).toEqual([
      ["devsync.review.approved", { taskId, reviewRequestId: secondRequest }],
    ]);

    await updateTask(host, ctx, taskId, { version: await versionOf(taskId), status: "DONE" });
    expect(emitted()).toEqual([
      ["devsync.task.moved", { taskId, from: "REVIEW", to: "DONE" }],
      ["devsync.task.done", { taskId }],
    ]);
  });

  it("release a claim a member's cancel ends, and an expired one another agent takes over", async () => {
    const { host, ctx, codex, claude, emitted } = await setup();
    const readyTask = async () => {
      const created = await createTask(host, ctx, requirements);
      await updateTask(host, ctx, created.id, { version: created.version, status: "READY" });
      return created.id;
    };
    const cancelled = await readyTask();
    const claimed = await claimTask(host, codex, { taskId: cancelled, claimId: randomUUID() });
    emitted();
    await updateTask(host, ctx, cancelled, { version: claimed.version, status: "CANCELLED" });
    expect(emitted()).toEqual([
      ["devsync.task.released", { taskId: cancelled, agentId: codex.agentId }],
      ["devsync.task.moved", { taskId: cancelled, from: "CLAIMED", to: "CANCELLED" }],
    ]);

    const taken = await readyTask();
    await claimTask(host, codex, { taskId: taken, claimId: randomUUID() });
    emitted();
    setClock(host, host.clock.now().getTime() + 16 * MINUTE);
    await claimTask(host, claude, { taskId: taken, claimId: randomUUID() });
    expect(emitted()).toEqual([
      ["devsync.task.released", { taskId: taken, agentId: codex.agentId }],
      ["devsync.task.claimed", { taskId: taken, agentId: claude.agentId }],
    ]);
  });

  it("tell a pull request linked to a task, and merged, for each task linked to it, once per delivery", async () => {
    const { host, project, ctx, emitted } = await setup();
    const created = await createTask(host, ctx, requirements);
    const taskId = created.id;
    const later = await createTask(host, ctx, { ...requirements, title: "Ship card checkout" });
    const pullRequestFact = (action: string, merged: boolean, deliveryId = randomUUID()) =>
      applyGithubFact(host, {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        fact: {
          kind: "pull_request",
          deliveryId,
          action,
          number: 7,
          title: "Ship checkout",
          state: merged ? "closed" : "open",
          merged,
          url: "https://github.com/acme/shop/pull/7",
          headRef: "checkout",
          headSha: "a".repeat(40),
          updatedAt: merged ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
        },
      });
    await pullRequestFact("opened", false);
    // The task made later is linked first: the merge still tells the tasks in creation order.
    await linkPullRequest(host, ctx, later.id, { number: 7 });
    emitted();
    await linkPullRequest(host, ctx, taskId, { number: 7 });
    expect(emitted()).toEqual([["devsync.pr.linked", { taskId, number: 7 }]]);
    await linkPullRequest(host, ctx, taskId, { number: null });
    expect(emitted()).toEqual([]);
    await linkPullRequest(host, ctx, taskId, { number: 7 });
    emitted();

    const deliveryId = randomUUID();
    await pullRequestFact("closed", true, deliveryId);
    expect(emitted()).toEqual([
      ["devsync.pr.merged", { taskId, number: 7 }],
      ["devsync.pr.merged", { taskId: later.id, number: 7 }],
    ]);
    await pullRequestFact("closed", true, deliveryId);
    expect(emitted()).toEqual([]);
  });

  it("tell a run's end, its draft pull request linked, and nothing of its other changes", async () => {
    const { host, project, ctx, emitted } = await setup();
    const created = await createTask(host, ctx, requirements);
    const taskId = created.id;
    await updateTask(host, ctx, taskId, { version: created.version, status: "READY" });
    const asked = await requestRun(host, ctx, taskId);
    await approveRun(host, ctx, asked.id);
    await jobs["devsync.runs"].handler({ projectId: project.projectId, runId: asked.id }, host);
    emitted();
    const githubRunId = host.github.dispatches.at(-1)?.githubRunId ?? 0;
    const result = {
      schemaVersion: 1,
      runId: asked.id,
      status: "succeeded",
      failure: null,
      changedFiles: ["src/checkout.ts"],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 0.01,
      },
      models: ["claude-sonnet-5-5"],
      provider: "anthropic",
      pullRequestUrl: "https://github.com/acme/shop/pull/12",
      branch: `devsync/${asked.id}`,
    };
    host.github.artifacts.push({
      githubRunId,
      name: "devsync-result",
      files: artifactFiles({ "result.json": JSON.stringify(result) }),
    });
    await jobs["devsync.github"].handler(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        fact: {
          kind: "workflow_run",
          deliveryId: randomUUID(),
          githubRunId,
          conclusion: "success",
        },
      },
      host,
    );
    expect(emitted()).toEqual([
      ["devsync.run.finished", { taskId, runId: asked.id, status: "SUCCEEDED", failure: null }],
      ["devsync.pr.linked", { taskId, number: 12 }],
    ]);
  });

  it("tell a failed run's failure", async () => {
    const { host, project, ctx, emitted } = await setup();
    const created = await createTask(host, ctx, requirements);
    await updateTask(host, ctx, created.id, { version: created.version, status: "READY" });
    const asked = await requestRun(host, ctx, created.id);
    await approveRun(host, ctx, asked.id);
    await jobs["devsync.runs"].handler({ projectId: project.projectId, runId: asked.id }, host);
    emitted();
    await jobs["devsync.github"].handler(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        fact: {
          kind: "workflow_run",
          deliveryId: randomUUID(),
          githubRunId: host.github.dispatches.at(-1)?.githubRunId ?? 0,
          conclusion: "cancelled",
        },
      },
      host,
    );
    expect(emitted()).toEqual([
      [
        "devsync.run.finished",
        { taskId: created.id, runId: asked.id, status: "FAILED", failure: "cancelled" },
      ],
    ]);
  });
});
