/**
 * Proof-of-gap tests from the 2026-11-26 security audit: each asserts the *current* (weak)
 * behaviour, so it passes while documenting the gap. Not part of any package's test run; copy this
 * file into packages/server/src/ to execute it.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actions } from "./actions";
import { agent, run as runTable } from "./db";
import { claimTask } from "./domain/claims";
import { askAgentQuestion } from "./domain/questions";
import { applyWorkflowRun, listRuns, requestRun } from "./domain/runs";
import { publishSignal } from "./domain/signals";
import { createTask, getTask, updateTask } from "./domain/tasks";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "./host";
import {
  artifactFiles,
  createTestDb,
  type FakeHost,
  fakeHost,
  fakeToken,
  type TestDb,
} from "./testing";

const workspaceId = "00000000-0000-4000-8000-0000000000a1";
const projectA: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b1",
  fullName: "acme/shop",
  readOnly: false,
};
const frozen: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b3",
  fullName: "acme/frozen",
  readOnly: true,
};
const owner: Member = {
  userId: "00000000-0000-4000-8000-0000000000c1",
  name: "Olga",
  role: "owner",
};
const fields = { title: "Task", description: "d", acceptanceCriteria: "a" };

let testDb: TestDb;
let host: FakeHost;
let clock: number;

beforeEach(async () => {
  testDb = await createTestDb();
  host = fakeHost(testDb.db, {
    members: { [workspaceId]: [owner] },
    projects: [projectA, frozen],
  });
  clock = Date.parse("2026-03-01T10:00:00.000Z");
  host.clock = { now: () => new Date(clock) };
});

afterEach(async () => {
  await testDb.close();
});

function as(member: Member, project: ProjectRef = projectA): ProjectContext {
  return { project, member };
}

async function seedAgent(project: ProjectRef, name = "builder"): Promise<AgentActor> {
  const [row] = await testDb.db
    .insert(agent)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      name,
      kind: "CLAUDE",
      tokenHash: fakeToken(),
      expiresAt: new Date(clock + 86_400_000),
    })
    .returning();
  if (!row) throw new Error("no agent");
  return { kind: "agent", agentId: row.id, name, project };
}

describe("GAP 1: a managed run's token reads every task of the project", () => {
  it("answers all the project's tasks, not only the run's own", async () => {
    const first = await createTask(host, as(owner), { ...fields, title: "First task" });
    const second = await createTask(host, as(owner), { ...fields, title: "Second task" });

    const ctx = {
      project: projectA,
      caller: { kind: "run" as const, runRef: randomUUID(), module: "devsync" },
      via: "mcp" as const,
      host,
    };
    const state = actions.find((a) => a.name === "get_project_state");
    const read = actions.find((a) => a.name === "get_task");
    if (!state || !read) throw new Error("actions missing");

    const listing = (await state.run(ctx, {})) as { result: { tasks: { id: string }[] } };
    expect(listing.result.tasks.map((t) => t.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    const detail = (await read.run(ctx, { taskId: second.id })) as {
      result: { task: { id: string } };
    };
    expect(detail.result.task.id).toBe(second.id);
  });
});

describe("GAP 2: a run may be asked for before the task's dependencies are done", () => {
  it("creates the run, while a claim of the same task is refused", async () => {
    const dependency = await createTask(host, as(owner), { ...fields, title: "Dependency" });
    const waiting = await createTask(host, as(owner), {
      ...fields,
      title: "Waiting",
      dependsOn: [dependency.id],
    });
    await updateTask(host, as(owner), waiting.id, { version: waiting.version, status: "READY" });

    const builder = await seedAgent(projectA);
    await expect(
      claimTask(host, builder, { taskId: waiting.id, claimId: randomUUID() }),
    ).rejects.toThrow(/waits for task/);

    const asked = await requestRun(host, as(owner), waiting.id);
    expect(asked.status).toBe("REQUESTED");
  });
});

describe("GAP 3: no cap on a task's questions, only 20 a minute", () => {
  it("keeps 40 open questions when asked across two minutes", async () => {
    const builder = await seedAgent(projectA);
    const task = await createTask(host, as(owner), { ...fields, title: "Asked" });

    const ask = (n: number) =>
      askAgentQuestion(host, builder, {
        taskId: task.id,
        requestId: randomUUID(),
        text: `Question ${n}?`,
      });

    for (let i = 0; i < 20; i++) await ask(i);
    await expect(ask(20)).rejects.toThrow(/20 signals, questions and answers/);

    clock += 61_000;
    for (let i = 0; i < 20; i++) await ask(100 + i);

    const detail = await getTask(host, as(owner), task.id);
    expect(detail.questions).toHaveLength(40);
    expect(detail.questions.every((q) => q.status === "OPEN")).toBe(true);
  });
});

describe("GAP 4: a member may message an agent on a read-only project", () => {
  it("keeps the signal, while DevSync's own writes to it are refused", async () => {
    const builder = await seedAgent(frozen);
    const receipt = await publishSignal(host, as(owner, frozen), builder.agentId, {
      kind: "system.warning",
      message: "A message on a project past its plan",
      idempotencyKey: randomUUID(),
    });
    expect(receipt.id).toBeTruthy();
    await expect(createTask(host, as(owner, frozen), { ...fields })).rejects.toThrow(/read-only/);
  });
});

describe("GAP 6: a Done task's requirements can still be rewritten", () => {
  it("keeps a new revision on a task whose status is final", async () => {
    const builder = await seedAgent(projectA);
    const task = await createTask(host, builder, {
      ...fields,
      title: "Delivered",
      requestId: randomUUID(),
    });
    await updateTask(host, as(owner), task.id, { version: task.version, status: "CANCELLED" });

    const after = await updateTask(host, as(owner), task.id, {
      version: task.version + 1,
      description: "Rewritten after the work was closed",
    });
    expect(after.status).toBe("CANCELLED");
    expect(after.revision).toBe(2);
    const detail = await getTask(host, as(owner), task.id);
    expect(detail.revisions[0]?.description).toBe("Rewritten after the work was closed");
  });
});

describe("GAP 5: a run's changed paths and models are stored and shown unredacted", () => {
  it("keeps a token-shaped value from result.json", async () => {
    const task = await createTask(host, as(owner), { ...fields, title: "Run" });
    const githubRunId = 12345;
    const [row] = await testDb.db
      .insert(runTable)
      .values({
        workspaceId: projectA.workspaceId,
        projectId: projectA.projectId,
        taskId: task.id,
        revision: 1,
        requestedByUserId: owner.userId,
        status: "RUNNING",
        githubRunId,
      })
      .returning();
    if (!row) throw new Error("no run");

    const secret = fakeToken();
    host.github.artifacts.push({
      githubRunId,
      name: "devsync-result",
      files: artifactFiles({
        "result.json": JSON.stringify({
          schemaVersion: 1,
          runId: row.id,
          status: "succeeded",
          failure: null,
          changedFiles: [`src/${secret}.ts`],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsd: 0.01,
          },
          models: [secret],
          provider: "anthropic",
          turns: 1,
          pullRequestUrl: "https://github.com/acme/shop/pull/42",
          branch: "devsync/branch",
        }),
      }),
    });

    await applyWorkflowRun(host, projectA, {
      kind: "workflow_run",
      deliveryId: "delivery-1",
      githubRunId,
      conclusion: "success",
    });

    const { runs } = await listRuns(host, { project: projectA }, task.id);
    const run = runs[0];
    if (!run) throw new Error("no run listed");
    expect(run.changedFiles).toContain(`src/${secret}.ts`);
    expect(run.usage?.models).toContain(secret);
    // The host's redactor would have replaced it, had DevSync passed the result through it.
    expect(host.redact(`src/${secret}.ts`)).not.toContain(secret);
  });
});
