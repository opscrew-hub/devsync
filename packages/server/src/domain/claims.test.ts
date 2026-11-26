import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { task, taskDependency } from "../db";
import type { AgentActor, DevSyncError, ProjectRef } from "../host";
import { hostAgent, refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { claimTask, releaseTask, renewTaskClaim } from "./claims";

const MINUTE = 60 * 1000;
const LEASE = 15 * MINUTE;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** A project with two agents, another project with one, and a task in the first. */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const owner = { userId: crypto.randomUUID(), name: "Owner", role: "owner" as const };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner] },
    projects: [project, other],
  });
  const register = async (name: string, on = project) =>
    (await hostAgent(host, on, { name, kind: "CODEX" })).actor;
  const agents = [await register("Codex"), await register("Claude")] as const;
  const outsider = await register("Outsider", other);
  const [created] = await testDb.db
    .insert(task)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      title: "Test task",
      description: "",
      acceptanceCriteria: "",
      creatorUserId: owner.userId,
      createdAt: new Date(FAKE_NOW),
      updatedAt: new Date(FAKE_NOW),
    })
    .returning();
  if (!created) throw new Error("no task");
  return { host, agents, outsider, taskId: created.id };
}

async function readTask(id: string) {
  const [row] = await testDb.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error("no task");
  return row;
}

describe("task claims", () => {
  // PGlite has one connection, so the two claims below run one after the other: real concurrency is
  // held at the database level by claimTask's conditional UPDATE.
  it("go to one agent of two claiming a task, are scoped, renewable and recoverable once expired", async () => {
    const { host, agents, outsider, taskId } = await setup();
    const start = Date.parse(FAKE_NOW);
    // Not Ready yet.
    await refusal(claimTask(host, agents[0], { taskId, claimId: crypto.randomUUID() }), "conflict");
    await testDb.db.update(task).set({ status: "READY" }).where(eq(task.id, taskId));
    await refusal(claimTask(host, outsider, { taskId, claimId: crypto.randomUUID() }), "not-found");

    const claimIds = [crypto.randomUUID(), crypto.randomUUID()] as const;
    const results = await Promise.allSettled(
      agents.map((agent, i) => claimTask(host, agent, { taskId, claimId: claimIds[i] as string })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    const loser = 1 - winner;
    const rejected = results[loser];
    expect(rejected?.status === "rejected" && (rejected.reason as DevSyncError).code).toBe(
      "conflict",
    );
    const winnerAgent = agents[winner] as AgentActor;
    const loserAgent = agents[loser] as AgentActor;
    const winnerClaim = { taskId, claimId: claimIds[winner] as string };
    const loserClaim = { taskId, claimId: claimIds[loser] as string };

    // Claiming again with the same claim id answers the same lease.
    const original = await claimTask(host, winnerAgent, winnerClaim);
    expect(original).toEqual({
      id: taskId,
      status: "CLAIMED",
      revision: 1,
      version: 2,
      claimId: winnerClaim.claimId,
      claimExpiresAt: new Date(start + LEASE).toISOString(),
    });
    expect(await readTask(taskId)).toMatchObject({
      status: "CLAIMED",
      claimAgentId: winnerAgent.agentId,
      version: 2,
      updatedAt: new Date(start),
    });
    await refusal(releaseTask(host, loserAgent, winnerClaim), "conflict");
    await refusal(renewTaskClaim(host, loserAgent, winnerClaim), "conflict");
    await refusal(releaseTask(host, outsider, winnerClaim), "conflict");

    // A member revises the requirements while the task is claimed (T322's edit, done directly).
    await testDb.db
      .update(task)
      .set({ revision: sql`${task.revision} + 1`, version: sql`${task.version} + 1` })
      .where(eq(task.id, taskId));
    setClock(host, start + 5 * MINUTE);
    const renewed = await renewTaskClaim(host, winnerAgent, winnerClaim);
    expect(renewed).toMatchObject({ revision: 2, version: 3, claimId: winnerClaim.claimId });
    expect(renewed.claimExpiresAt).toBe(new Date(start + 5 * MINUTE + LEASE).toISOString());

    // The lease runs out: no renewal, and another agent recovers the task.
    setClock(host, start + 5 * MINUTE + LEASE);
    await refusal(renewTaskClaim(host, winnerAgent, winnerClaim), "conflict");
    await refusal(releaseTask(host, winnerAgent, winnerClaim), "conflict");
    // An expired claim isn't taken back under the same claim id.
    await refusal(claimTask(host, winnerAgent, winnerClaim), "conflict");
    const recovered = await claimTask(host, loserAgent, loserClaim);
    expect(recovered).toMatchObject({ claimId: loserClaim.claimId, revision: 2, version: 4 });
    await refusal(releaseTask(host, winnerAgent, winnerClaim), "conflict");
    await refusal(
      claimTask(host, winnerAgent, { taskId, claimId: crypto.randomUUID() }),
      "conflict",
    );

    setClock(host, start + 6 * MINUTE + LEASE);
    expect(await releaseTask(host, loserAgent, loserClaim)).toEqual({
      id: taskId,
      status: "READY",
    });
    expect(await readTask(taskId)).toMatchObject({
      status: "READY",
      claimAgentId: null,
      claimId: null,
      claimExpiresAt: null,
      version: 5,
      updatedAt: new Date(start + 6 * MINUTE + LEASE),
    });
    await refusal(releaseTask(host, loserAgent, loserClaim), "conflict");
  });

  it("refuses another project's task, an unknown task and invalid ids", async () => {
    const { host, agents, outsider } = await setup();
    const claimId = crypto.randomUUID();
    await refusal(
      claimTask(host, agents[0], { taskId: crypto.randomUUID(), claimId }),
      "not-found",
    );
    const elsewhere = await testDb.db
      .insert(task)
      .values({
        workspaceId: outsider.project.workspaceId,
        projectId: outsider.project.projectId,
        title: "Elsewhere",
        description: "",
        acceptanceCriteria: "",
        status: "READY",
      })
      .returning();
    const taskId = elsewhere[0]?.id ?? "";
    await refusal(claimTask(host, agents[0], { taskId, claimId }), "not-found");
    expect((await readTask(taskId)).status).toBe("READY");
    const error = await refusal(claimTask(host, agents[0], { taskId, claimId: "nope" }), "invalid");
    expect(error.fields).toEqual(["claimId"]);
  });

  it("wait for the tasks a task depends on: refused while one is open, taken once all are done", async () => {
    const { host, agents, taskId } = await setup();
    const scope = {
      workspaceId: agents[0].project.workspaceId,
      projectId: agents[0].project.projectId,
    };
    const dependency = async (title: string) => {
      const [row] = await testDb.db
        .insert(task)
        .values({ ...scope, title, description: "", acceptanceCriteria: "", status: "REVIEW" })
        .returning();
      if (!row) throw new Error("no task");
      return row.id;
    };
    const cart = await dependency("Add a cart");
    const prices = await dependency("Show prices");
    await testDb.db.insert(taskDependency).values([
      { ...scope, taskId, dependsOnTaskId: cart, position: 0 },
      { ...scope, taskId, dependsOnTaskId: prices, position: 1 },
    ]);
    await testDb.db.update(task).set({ status: "READY" }).where(eq(task.id, taskId));

    const claim = { taskId, claimId: crypto.randomUUID() };
    const waiting = await refusal(claimTask(host, agents[0], claim), "conflict");
    expect(waiting.message).toBe(
      'This task waits for task "Add a cart". Claim it once that is done.',
    );
    await testDb.db.update(task).set({ status: "DONE" }).where(eq(task.id, cart));
    expect((await refusal(claimTask(host, agents[0], claim), "conflict")).message).toBe(
      'This task waits for task "Show prices". Claim it once that is done.',
    );
    expect((await readTask(taskId)).status).toBe("READY");
    // Cancelled counts as done.
    await testDb.db.update(task).set({ status: "CANCELLED" }).where(eq(task.id, prices));
    expect(await claimTask(host, agents[0], claim)).toMatchObject({ status: "CLAIMED" });
  });

  it("hold at most 3 tasks per agent: a fourth claim, or a takeover, is refused until one ends", async () => {
    const { host, agents } = await setup();
    const scope = {
      workspaceId: agents[0].project.workspaceId,
      projectId: agents[0].project.projectId,
    };
    const ready = async () => {
      const [row] = await testDb.db
        .insert(task)
        .values({
          ...scope,
          title: "Ready",
          description: "",
          acceptanceCriteria: "",
          status: "READY",
        })
        .returning();
      if (!row) throw new Error("no task");
      return row.id;
    };
    const start = Date.parse(FAKE_NOW);
    const [codex, claude] = agents;
    const held = [];
    for (let i = 0; i < 3; i++) {
      const claim = { taskId: await ready(), claimId: crypto.randomUUID() };
      await claimTask(host, codex, claim);
      held.push(claim);
    }
    // Claiming one of them again under its own claim is the same claim, not a fourth.
    expect(await claimTask(host, codex, held[0] as (typeof held)[0])).toMatchObject({
      status: "CLAIMED",
    });
    const fourth = { taskId: await ready(), claimId: crypto.randomUUID() };
    const error = await refusal(claimTask(host, codex, fourth), "conflict");
    expect(error.message).toBe(
      "You hold 3 claimed tasks. Release, finish or report a blocker on one before claiming another.",
    );
    expect((await readTask(fourth.taskId)).status).toBe("READY");
    // Another agent's claims are its own.
    await claimTask(host, claude, { taskId: await ready(), claimId: crypto.randomUUID() });

    // Taking over another agent's expired claim counts the same way.
    const theirs = { taskId: await ready(), claimId: crypto.randomUUID() };
    await claimTask(host, claude, theirs);
    setClock(host, start + 10 * MINUTE);
    for (const claim of held) await renewTaskClaim(host, codex, claim);
    setClock(host, start + LEASE + MINUTE);
    const takeover = { taskId: theirs.taskId, claimId: crypto.randomUUID() };
    await refusal(claimTask(host, codex, takeover), "conflict");

    // Once one ends, another may be claimed; an expired claim holds nothing.
    await releaseTask(host, codex, held[0] as (typeof held)[0]);
    expect(await claimTask(host, codex, takeover)).toMatchObject({ claimId: takeover.claimId });
    setClock(host, start + 10 * MINUTE + LEASE + MINUTE);
    expect(await claimTask(host, codex, fourth)).toMatchObject({ claimId: fourth.claimId });
  });

  it("are refused on a read-only project", async () => {
    const { host, agents, taskId } = await setup();
    await testDb.db.update(task).set({ status: "READY" }).where(eq(task.id, taskId));
    const frozen: AgentActor = {
      ...agents[0],
      project: { ...agents[0].project, readOnly: true },
    };
    const claim = { taskId, claimId: crypto.randomUUID() };
    await refusal(claimTask(host, frozen, claim), "forbidden");
    await claimTask(host, agents[0], claim);
    await refusal(renewTaskClaim(host, frozen, claim), "forbidden");
    await refusal(releaseTask(host, frozen, claim), "forbidden");
    expect((await readTask(taskId)).status).toBe("CLAIMED");
  });
});
