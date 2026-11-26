/**
 * A task's fields beyond its requirements (docs/platform.md, P4): the paths it may change and the
 * open tasks whose paths overlap them, the tasks it waits for, its labels and its branch, and the
 * usage its agents and runs reported.
 */
import { randomUUID } from "node:crypto";
import { Task, TaskDetail } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outboxEvent, run, task, taskDependency, taskRevision } from "../db";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "../host";
import { hostAgent, refusal } from "../test/helpers";
import { createTestDb, type FakeHost, fakeHost, fakeToken, type TestDb } from "../testing";
import { createTask, getTask, listTasks, updateTask } from "./tasks";

const workspaceId = randomUUID();
const projectA: ProjectRef = {
  workspaceId,
  projectId: randomUUID(),
  fullName: "acme/shop",
  readOnly: false,
};
const projectB: ProjectRef = { ...projectA, projectId: randomUUID(), fullName: "acme/api" };
const owner: Member = { userId: randomUUID(), name: "Olga", role: "owner" };
const none = { description: "", acceptanceCriteria: "" };

let testDb: TestDb;
let host: FakeHost;
let clock: number;

beforeEach(async () => {
  testDb = await createTestDb();
  host = fakeHost(testDb.db, {
    members: { [workspaceId]: [owner] },
    projects: [projectA, projectB],
  });
  clock = Date.parse("2026-03-01T10:00:00.000Z");
  host.clock = { now: () => new Date(clock) };
});

afterEach(async () => {
  await testDb.close();
});

function as(project: ProjectRef = projectA): ProjectContext {
  return { project, member: owner };
}

/** A member's task, made a second after the last one. */
async function make(title: string, fields: object = {}, project = projectA): Promise<Task> {
  clock += 1000;
  return createTask(host, as(project), { title, ...none, ...fields });
}

/** Moves a task straight to `status`, as its lifecycle would have. */
async function setStatus(taskId: string, status: Task["status"]) {
  await testDb.db.update(task).set({ status }).where(eq(task.id, taskId));
}

async function agentOf(project: ProjectRef = projectA): Promise<AgentActor> {
  return (await hostAgent(host, project, { name: "Builder", kind: "CLAUDE" })).actor;
}

describe("a task's fields", () => {
  it("are empty on a task made without them, and kept as given on one made with them", async () => {
    const plain = await make("Plain");
    expect(plain).toMatchObject({ owns: [], dependsOn: [], labels: [], branch: null });
    const cart = await make("Add a cart");
    const created = await make("Ship checkout", {
      owns: ["src/checkout/", "README.md"],
      dependsOn: [cart.id, plain.id],
      labels: ["payments", "UI"],
      branch: "feature/checkout",
    });
    expect(Task.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      owns: ["src/checkout/", "README.md"],
      dependsOn: [cart.id, plain.id],
      labels: ["payments", "UI"],
      branch: "feature/checkout",
    });
    // Lists answer them too, the tasks it waits for in their order.
    const { tasks } = await listTasks(host, as());
    expect(tasks.find((t) => t.id === created.id)?.dependsOn).toEqual([cart.id, plain.id]);
    const detail = await getTask(host, as(), created.id);
    expect(TaskDetail.parse(detail)).toEqual(detail);
    expect(detail.dependencies).toEqual([
      { id: cart.id, title: "Add a cart", status: "BACKLOG" },
      { id: plain.id, title: "Plain", status: "BACKLOG" },
    ]);
  });

  it("change without a new requirements revision or a timeline event, the version bumped", async () => {
    const created = await make("Ship checkout");
    const other = await make("Add a cart");
    const edited = await updateTask(host, as(), created.id, {
      version: created.version,
      owns: ["src/"],
      dependsOn: [other.id],
      labels: ["payments"],
      branch: "feature/checkout",
    });
    expect(edited).toMatchObject({
      revision: 1,
      version: 2,
      owns: ["src/"],
      dependsOn: [other.id],
      labels: ["payments"],
      branch: "feature/checkout",
    });
    expect(
      await testDb.db.select().from(taskRevision).where(eq(taskRevision.taskId, created.id)),
    ).toHaveLength(1);
    const kinds = await testDb.db
      .select({ kind: outboxEvent.kind })
      .from(outboxEvent)
      .where(eq(outboxEvent.taskId, created.id));
    expect(kinds).toEqual([{ kind: "task.created" }]);

    // Left out, a field stays as it is; given, it is replaced: an empty list or a null clears it.
    const kept = await updateTask(host, as(), created.id, { version: 2, labels: ["ui", "api"] });
    expect(kept).toMatchObject({ owns: ["src/"], dependsOn: [other.id], labels: ["ui", "api"] });
    const cleared = await updateTask(host, as(), created.id, {
      version: 3,
      owns: [],
      dependsOn: [],
      branch: null,
    });
    expect(cleared).toMatchObject({ owns: [], dependsOn: [], labels: ["ui", "api"], branch: null });
    expect(
      await testDb.db.select().from(taskDependency).where(eq(taskDependency.taskId, created.id)),
    ).toEqual([]);
  });

  it("refuse a bad path, label or branch by the field's name", async () => {
    const created = await make("Ship checkout");
    for (const [field, value] of [
      ["owns", ["../outside"]],
      ["labels", ["ui", "UI"]],
      ["branch", "has space"],
      ["dependsOn", [created.id, created.id]],
    ] as const) {
      const error = await refusal(
        updateTask(host, as(), created.id, { version: 1, [field]: value }),
        "invalid",
      );
      expect(error.fields?.[0]).toMatch(new RegExp(`^${field}`));
    }
  });
});

describe("the tasks a task waits for", () => {
  it("are the project's tasks: another project's, an unknown one or itself is refused", async () => {
    const created = await make("Ship checkout");
    const elsewhere = await make("Elsewhere", {}, projectB);
    for (const dependsOn of [[elsewhere.id], [randomUUID()]]) {
      const error = await refusal(make("New", { dependsOn }), "invalid");
      expect(error.fields).toEqual(["dependsOn"]);
      expect(error.message).toBe(
        "A task it waits for isn't one of this project's tasks. Pick them from this project's tasks.",
      );
      await refusal(updateTask(host, as(), created.id, { version: 1, dependsOn }), "invalid");
    }
    const itself = await refusal(
      updateTask(host, as(), created.id, { version: 1, dependsOn: [created.id] }),
      "invalid",
    );
    expect(itself.message).toBe(
      "A task can't wait for itself. Remove it from the tasks it waits for.",
    );
    expect(await testDb.db.select().from(taskDependency)).toEqual([]);
    expect((await getTask(host, as(), created.id)).version).toBe(1);
  });

  it("can't wait for each other in a circle, however long", async () => {
    const a = await make("A");
    const b = await make("B", { dependsOn: [a.id] });
    const c = await make("C", { dependsOn: [b.id] });
    const error = await refusal(
      updateTask(host, as(), a.id, { version: a.version, dependsOn: [c.id] }),
      "conflict",
    );
    expect(error.message).toBe(
      'Task "C" already waits for this task, so this task can\'t wait for it. Remove it from the tasks this one waits for.',
    );
    await refusal(
      updateTask(host, as(), b.id, { version: b.version, dependsOn: [c.id] }),
      "conflict",
    );
    // A task waiting on both ends of a chain is no circle.
    const d = await make("D", { dependsOn: [a.id, c.id] });
    expect(
      await updateTask(host, as(), b.id, { version: b.version, dependsOn: [a.id] }),
    ).toMatchObject({ dependsOn: [a.id] });
    expect((await getTask(host, as(), d.id)).dependsOn).toEqual([a.id, c.id]);
  });
});

describe("an agent's fields", () => {
  it("pass the host's redactor, and are refused when what it left isn't a valid field", async () => {
    const builder = await agentOf();
    const secret = fakeToken();
    const created = await createTask(host, builder, {
      requestId: randomUUID(),
      title: "Agent task",
      ...none,
      owns: [`src/${secret}.ts`],
      branch: "feature/agent",
    });
    expect(created).toMatchObject({ owns: ["src/[redacted].ts"], branch: "feature/agent" });
    expect(JSON.stringify(created)).not.toContain(secret);
    // A label is too short for a token: a redactor that knows a shorter secret.
    const redact = host.redact;
    host.redact = (text) => redact(text).replaceAll("hunter2", "[redacted]");
    const edited = await updateTask(host, builder, created.id, {
      version: created.version,
      labels: ["pw-hunter2"],
    });
    expect(edited.labels).toEqual(["pw-[redacted]"]);
    // A member's fields are kept as they wrote them.
    const member = await updateTask(host, as(), created.id, {
      version: edited.version,
      labels: ["pw-hunter2"],
    });
    expect(member.labels).toEqual(["pw-hunter2"]);
    // `[redacted]` is no branch name git takes.
    const error = await refusal(
      updateTask(host, builder, created.id, { version: member.version, branch: `x/${secret}` }),
      "invalid",
    );
    expect(error.fields).toEqual(["branch"]);
    expect(error.message).not.toContain(secret);
    const [row] = await testDb.db.select().from(task).where(eq(task.id, created.id));
    expect(JSON.stringify(row)).not.toContain(secret);
  });
});

describe("overlapping paths", () => {
  it("flag two open tasks on both, with the paths they share", async () => {
    const checkout = await make("Ship checkout", { owns: ["src/checkout/", "README.md"] });
    const total = await make("Fix the total", { owns: ["src/checkout/total.ts", "docs/"] });
    const readme = await make("Rewrite the readme", { owns: ["README.md", "docs/intro.md"] });
    await make("Unrelated", { owns: ["src/checkout.ts", "src/checkoutx/"] });
    await make("No paths");

    expect((await getTask(host, as(), checkout.id)).overlaps).toEqual([
      {
        task: { id: total.id, title: "Fix the total", status: "BACKLOG" },
        paths: ["src/checkout/total.ts"],
      },
      {
        task: { id: readme.id, title: "Rewrite the readme", status: "BACKLOG" },
        paths: ["README.md"],
      },
    ]);
    expect((await getTask(host, as(), total.id)).overlaps).toEqual([
      {
        task: { id: checkout.id, title: "Ship checkout", status: "BACKLOG" },
        paths: ["src/checkout/total.ts"],
      },
      {
        task: { id: readme.id, title: "Rewrite the readme", status: "BACKLOG" },
        paths: ["docs/intro.md"],
      },
    ]);
  });

  it("flag nothing once one of them is Done or Cancelled, nor another project's", async () => {
    const checkout = await make("Ship checkout", { owns: ["src/"] });
    const done = await make("Done", { owns: ["src/a.ts"] });
    const cancelled = await make("Cancelled", { owns: ["src/b.ts"] });
    await make("Elsewhere", { owns: ["src/"] }, projectB);
    await setStatus(done.id, "DONE");
    await setStatus(cancelled.id, "CANCELLED");
    expect((await getTask(host, as(), checkout.id)).overlaps).toEqual([]);
    expect((await getTask(host, as(), done.id)).overlaps).toEqual([]);
  });
});

describe("a task's usage", () => {
  it("sums its agents' reports and, apart, its managed runs', each null without any", async () => {
    const created = await make("Ship checkout");
    expect((await getTask(host, as(), created.id)).usage).toEqual({ agents: null, runs: null });

    const report = (usage: object | null, taskId = created.id) =>
      testDb.db.insert(outboxEvent).values({
        workspaceId,
        projectId: projectA.projectId,
        taskId,
        kind: "implementation.progress",
        payload: {},
        usage,
      });
    await report({ inputTokens: 100, outputTokens: 20, costUsd: 0.1, model: "claude-opus" });
    await report({ cacheReadInputTokens: 5, cacheCreationInputTokens: 7, costUsd: 0.2 });
    await report({ outputTokens: 1, model: "claude-opus" });
    await report(null);
    // Another task's report counts for it only.
    const other = await make("Other");
    await report({ inputTokens: 999 }, other.id);

    const runOf = (tokenUsage: object | null) =>
      testDb.db.insert(run).values({
        workspaceId,
        projectId: projectA.projectId,
        taskId: created.id,
        revision: 1,
        requestedByUserId: owner.userId,
        status: "SUCCEEDED",
        tokenUsage,
      });
    const runUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 30,
      costUsd: 1.5,
      models: ["claude-sonnet"],
      turns: 4,
    };
    await runOf(runUsage);
    await runOf({ ...runUsage, costUsd: 0.25, models: ["claude-sonnet", "claude-haiku"] });
    await runOf(null);

    expect((await getTask(host, as(), created.id)).usage).toEqual({
      agents: {
        inputTokens: 100,
        outputTokens: 21,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 5,
        costUsd: 0.3,
        models: ["claude-opus"],
        count: 3,
      },
      runs: {
        inputTokens: 2000,
        outputTokens: 400,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 60,
        costUsd: 1.75,
        // Each once, in alphabetical order.
        models: ["claude-haiku", "claude-sonnet"],
        count: 2,
      },
    });
  });
});
