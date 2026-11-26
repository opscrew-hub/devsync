import { randomUUID } from "node:crypto";
import { Task, TaskDetail, WorkspaceTaskList } from "@devsync/schemas";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, outboxEvent, pullRequest, task, taskComment, taskRevision } from "../db";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "../host";
import { refusal, sampleFinding } from "../test/helpers";
import { createTestDb, type FakeHost, fakeHost, fakeToken, type TestDb } from "../testing";
import {
  commentOnTask,
  createTask,
  getTask,
  linkPullRequest,
  listTasks,
  listWorkspaceTasks,
  updateTask,
} from "./tasks";

const workspaceId = "00000000-0000-4000-8000-0000000000a1";
const otherWorkspaceId = "00000000-0000-4000-8000-0000000000a2";
const projectA: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b1",
  fullName: "acme/shop",
  readOnly: false,
};
const projectB: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b2",
  fullName: "acme/api",
  readOnly: false,
};
const owner: Member = {
  userId: "00000000-0000-4000-8000-0000000000c1",
  name: "Olga",
  role: "owner",
};
const admin: Member = {
  userId: "00000000-0000-4000-8000-0000000000c2",
  name: "Ari",
  role: "admin",
};
const approver: Member = {
  userId: "00000000-0000-4000-8000-0000000000c3",
  name: "Pia",
  role: "approver",
};
const developer: Member = {
  userId: "00000000-0000-4000-8000-0000000000c4",
  name: "Dev",
  role: "developer",
};
const outsiderId = "00000000-0000-4000-8000-0000000000c9";
const members = [owner, admin, approver, developer];
const fields = { title: "Ship checkout", description: "Card payments", acceptanceCriteria: "Pays" };

let testDb: TestDb;
let host: FakeHost;
let clock: number;

beforeEach(async () => {
  testDb = await createTestDb();
  host = fakeHost(testDb.db, {
    members: { [workspaceId]: [...members] },
    projects: [projectA, projectB],
  });
  clock = Date.parse("2026-03-01T10:00:00.000Z");
  host.clock = { now: () => new Date(clock) };
});

afterEach(async () => {
  await testDb.close();
});

/** Moves the fake clock a second on, so rows written next sort after the last ones. */
function tick() {
  clock += 1000;
}

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

async function seedPullRequest(project: ProjectRef, number: number) {
  await testDb.db.insert(pullRequest).values({
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    number,
    title: `Pull request ${number}`,
    state: "open",
    url: `https://github.com/${project.fullName}/pull/${number}`,
    headRef: "feature",
    headSha: "a".repeat(40),
    sourceUpdatedAt: new Date("2026-02-28T00:00:00.000Z"),
  });
}

async function events(taskId: string) {
  return testDb.db
    .select()
    .from(outboxEvent)
    .where(eq(outboxEvent.taskId, taskId))
    .orderBy(outboxEvent.createdAt);
}

describe("createTask", () => {
  it("a member's task starts in Backlog at revision 1, its event recorded and the outbox woken", async () => {
    const created = await createTask(host, as(developer), {
      title: "  Ship checkout ",
      description: "Card payments",
      acceptanceCriteria: "Pays",
    });
    expect(Task.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      projectId: projectA.projectId,
      title: "Ship checkout",
      status: "BACKLOG",
      revision: 1,
      version: 1,
      assigneeUserId: null,
      claim: null,
      pullRequestNumber: null,
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });
    const [revision] = await testDb.db.select().from(taskRevision);
    expect(revision).toMatchObject({
      number: 1,
      title: "Ship checkout",
      authorUserId: developer.userId,
    });
    const [event] = await events(created.id);
    expect(event).toMatchObject({
      kind: "task.created",
      actorUserId: developer.userId,
      projectId: projectA.projectId,
      workspaceId,
      payload: {
        taskId: created.id,
        revision: 1,
        version: 1,
        message: "Task created: Ship checkout",
      },
    });
    expect(host.enqueued).toEqual([
      { queue: "devsync.outbox", payload: { projectId: projectA.projectId }, options: undefined },
    ]);
  });

  it("refuses invalid fields by name, never by value", async () => {
    const error = await refusal(
      createTask(host, as(owner), { title: " ", description: "", acceptanceCriteria: "" }),
    );
    expect(error.code).toBe("invalid");
    expect(error.fields).toEqual(["title"]);
    expect(error.message).toBe("Check this field and try again: title.");
  });

  it("an agent's retry with the same requestId answers the same task; other requirements under it are refused", async () => {
    const builder = await seedAgent(projectA);
    const requestId = randomUUID();
    const first = await createTask(host, builder, { ...fields, requestId });
    const again = await createTask(host, builder, { ...fields, requestId });
    expect(again).toEqual(first);
    expect(await testDb.db.select().from(task)).toHaveLength(1);
    expect(await events(first.id)).toHaveLength(1);
    expect(host.enqueued).toHaveLength(1);
    const [event] = await events(first.id);
    expect(event?.actorAgentId).toBe(builder.agentId);

    const error = await refusal(
      createTask(host, builder, { ...fields, title: "Something else", requestId }),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(
      "This request ID was already used for another task. Send a new request ID.",
    );

    const detail = await getTask(host, as(owner), first.id);
    expect(detail.creator).toEqual({ kind: "agent", agentId: builder.agentId, name: "builder" });
  });

  it("a member's retry with the same requestId answers the same task, as an agent's does", async () => {
    const requestId = randomUUID();
    const first = await createTask(host, as(owner), { ...fields, requestId });
    expect(await createTask(host, as(owner), { ...fields, requestId })).toEqual(first);
    expect(await testDb.db.select().from(task)).toHaveLength(1);
    expect(await events(first.id)).toHaveLength(1);
    expect(host.enqueued).toHaveLength(1);
    expect((await getTask(host, as(owner), first.id)).creator).toEqual({
      kind: "member",
      userId: owner.userId,
      name: "Olga",
    });

    const error = await refusal(
      createTask(host, as(owner), { ...fields, title: "Something else", requestId }),
      "conflict",
    );
    expect(error.message).toBe(
      "This request ID was already used for another task. Send a new request ID.",
    );
    // The request id is the member's own: another member's, or an agent's, is another task.
    const builder = await seedAgent(projectA);
    const theirs = await createTask(host, as(developer), { ...fields, requestId });
    const agents = await createTask(host, builder, { ...fields, requestId });
    expect(new Set([first.id, theirs.id, agents.id]).size).toBe(3);
    // Without one, each create is a task of its own.
    await createTask(host, as(owner), fields);
    await createTask(host, as(owner), fields);
    expect(await testDb.db.select().from(task)).toHaveLength(5);
  });

  it("refuses a member's second task under the same requestId at the database too", async () => {
    const requestId = randomUUID();
    await createTask(host, as(owner), { ...fields, requestId });
    const row = {
      workspaceId,
      projectId: projectA.projectId,
      ...fields,
      creatorUserId: owner.userId,
      createRequestId: requestId,
    };
    await expect(testDb.db.insert(task).values(row)).rejects.toThrow();
    await testDb.db.insert(task).values({ ...row, projectId: projectB.projectId });
  });

  it("an agent's task needs a requestId; a member's may take one", async () => {
    const builder = await seedAgent(projectA);
    expect((await refusal(createTask(host, builder, fields))).fields).toEqual(["requestId"]);
    const error = await refusal(createTask(host, as(owner), { ...fields, requestId: "r1" }));
    expect(error.code).toBe("invalid");
    expect(error.fields).toEqual(["requestId"]);
  });

  it("refuses writes to a read-only project, an agent's and a member's", async () => {
    const readOnly = { ...projectA, readOnly: true };
    const builder = { ...(await seedAgent(projectA)), project: readOnly };
    for (const actor of [builder, as(owner, readOnly)]) {
      const error = await refusal(createTask(host, actor, { ...fields, requestId: randomUUID() }));
      expect(error.code).toBe("forbidden");
      expect(error.message).toMatch(/read-only/);
    }
    expect(await testDb.db.select().from(task)).toEqual([]);
  });
});

describe("createTask from a security finding", () => {
  const finding = sampleFinding();

  async function stored(taskId: string) {
    const [row] = await testDb.db
      .select({
        fingerprint: task.findingFingerprint,
        rule: task.findingRule,
        file: task.findingFile,
      })
      .from(task)
      .where(eq(task.id, taskId));
    return row;
  }

  it("keeps the fingerprint, rule and file as the host gives them, read again on create", async () => {
    host.directory.findings[projectA.projectId] = [finding];
    const asked = vi.spyOn(host, "finding");
    const created = await createTask(host, as(developer), {
      ...fields,
      finding: { fingerprint: finding.fingerprint },
    });
    expect(asked).toHaveBeenCalledWith(projectA.projectId, finding.fingerprint);
    expect(await stored(created.id)).toEqual({
      fingerprint: finding.fingerprint,
      rule: finding.ruleId,
      file: finding.file,
    });
    // The task's own text is what the member wrote, and it is made like any other.
    expect(created).toMatchObject({ title: fields.title, status: "BACKLOG", revision: 1 });
    expect((await events(created.id)).map((e) => e.kind)).toEqual(["task.created"]);

    const plain = await createTask(host, as(developer), fields);
    expect(await stored(plain.id)).toEqual({ fingerprint: null, rule: null, file: null });
  });

  it("refuses a finding the host no longer gives, saving nothing", async () => {
    const error = await refusal(
      createTask(host, as(developer), { ...fields, finding: { fingerprint: finding.fingerprint } }),
      "not-found",
    );
    expect(error.message).toBe(
      "This finding is resolved or isn't this project's. Open it again from the project's security findings.",
    );
    expect(await testDb.db.select().from(task)).toEqual([]);
  });

  it("refuses a second task while the finding has an open one, by fingerprint or by rule and file", async () => {
    const moved = sampleFinding({ fingerprint: "config/client-exposed-secret:src/app.ts:30" });
    host.directory.findings[projectA.projectId] = [finding, moved];
    const first = await createTask(host, as(developer), {
      ...fields,
      title: "Fix the exposed secret.",
      finding: { fingerprint: finding.fingerprint },
    });
    for (const fingerprint of [finding.fingerprint, moved.fingerprint]) {
      const error = await refusal(
        createTask(host, as(owner), { ...fields, finding: { fingerprint } }),
        "conflict",
      );
      expect(error.message).toBe(
        'This finding already has a task, "Fix the exposed secret.". Open it instead.',
      );
    }
    expect(await testDb.db.select().from(task)).toHaveLength(1);
    // A task without the finding is still made.
    await createTask(host, as(owner), fields);

    // Once the first is Cancelled (or Done), a new task may be made from the finding.
    await updateTask(host, as(owner), first.id, { version: first.version, status: "CANCELLED" });
    const second = await createTask(host, as(owner), {
      ...fields,
      finding: { fingerprint: moved.fingerprint },
    });
    expect(await stored(second.id)).toEqual({
      fingerprint: moved.fingerprint,
      rule: moved.ruleId,
      file: moved.file,
    });
  });

  it("refuses a bad fingerprint by its field, and an agent's finding, before asking the host", async () => {
    host.directory.findings[projectA.projectId] = [finding];
    const asked = vi.spyOn(host, "finding");
    const bad = await refusal(
      createTask(host, as(developer), { ...fields, finding: { fingerprint: "a b" } }),
      "invalid",
    );
    expect(bad.fields).toEqual(["finding.fingerprint"]);
    const builder = await seedAgent(projectA);
    const agentsFinding = {
      ...fields,
      requestId: randomUUID(),
      finding: { fingerprint: finding.fingerprint },
    };
    expect((await refusal(createTask(host, builder, agentsFinding), "invalid")).fields).toEqual([
      "finding",
    ]);
    expect(asked).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(task)).toEqual([]);
  });

  it("refuses a read-only project before asking the host", async () => {
    host.directory.findings[projectA.projectId] = [finding];
    const asked = vi.spyOn(host, "finding");
    const readOnly = { ...projectA, readOnly: true };
    const input = { ...fields, finding: { fingerprint: finding.fingerprint } };
    await refusal(createTask(host, as(owner, readOnly), input), "forbidden");
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("every role", () => {
  it.each(members)("may create, edit, move, assign, comment and link as $role", async (member) => {
    await seedPullRequest(projectA, 7);
    const ctx = as(member);
    const created = await createTask(host, ctx, fields);
    const edited = await updateTask(host, ctx, created.id, {
      version: created.version,
      title: "Ship it",
      status: "READY",
    });
    const assigned = await updateTask(host, ctx, created.id, {
      version: edited.version,
      assigneeUserId: member.userId,
    });
    const comment = await commentOnTask(host, ctx, created.id, { body: "On it" });
    const linked = await linkPullRequest(host, ctx, created.id, { number: 7 });
    expect(assigned.assigneeUserId).toBe(member.userId);
    expect(comment.author).toEqual({ kind: "member", userId: member.userId, name: member.name });
    expect(linked).toMatchObject({ status: "READY", title: "Ship it", pullRequestNumber: 7 });
    expect((await listTasks(host, ctx)).tasks).toHaveLength(1);
    expect((await getTask(host, ctx, created.id)).comments).toHaveLength(1);
  });
});

describe("listTasks", () => {
  it("filters by status and assignee, most recently updated first, never another project's", async () => {
    const one = await createTask(host, as(owner), { ...fields, title: "One" });
    tick();
    const two = await createTask(host, as(owner), { ...fields, title: "Two" });
    tick();
    await createTask(host, as(owner, projectB), { ...fields, title: "Elsewhere" });
    tick();
    await updateTask(host, as(owner), one.id, { version: 1, assigneeUserId: developer.userId });
    tick();
    await updateTask(host, as(owner), two.id, { version: 1, status: "READY" });

    const titles = async (ctx: ProjectContext, query = {}) =>
      (await listTasks(host, ctx, query)).tasks.map((t) => t.title);
    expect(await titles(as(owner))).toEqual(["Two", "One"]);
    expect(await titles(as(owner), { status: "READY" })).toEqual(["Two"]);
    expect(await titles(as(owner), { status: "DONE" })).toEqual([]);
    expect(await titles(as(developer), { assignee: "me" })).toEqual(["One"]);
    expect(await titles(as(owner), { assignee: "me" })).toEqual([]);
    expect(await titles(as(owner), { assignee: "none" })).toEqual(["Two"]);
    expect(await titles(as(owner), { assignee: developer.userId })).toEqual(["One"]);
    expect(await titles(as(owner, projectB))).toEqual(["Elsewhere"]);
  });

  it("refuses an agent's and a run's `me` and an invalid filter", async () => {
    const builder = await seedAgent(projectA);
    for (const reader of [builder, { project: projectA }]) {
      const me = await refusal(listTasks(host, reader, { assignee: "me" }), "invalid");
      expect(me.message).toBe(
        "Only a member has tasks assigned to them. Leave out `assignee`, or give a member's user id.",
      );
      expect(me.fields).toEqual(["assignee"]);
    }
    const error = await refusal(listTasks(host, as(owner), { status: "LATER" } as never));
    expect(error.fields).toEqual(["status"]);
  });

  it("lets a managed run, which has only its project, list the project's tasks", async () => {
    await createTask(host, as(owner), { ...fields, title: "Mine" });
    await createTask(host, as(owner, projectB), { ...fields, title: "Elsewhere" });
    const run = { project: projectA };
    expect((await listTasks(host, run)).tasks.map((t) => t.title)).toEqual(["Mine"]);
    expect((await listTasks(host, run, { assignee: "none" })).tasks).toHaveLength(1);
  });

  it("shows a claim with its agent's name", async () => {
    const builder = await seedAgent(projectA, "claude-1");
    const created = await createTask(host, as(owner), fields);
    const expiresAt = new Date(clock + 900_000);
    await testDb.db
      .update(task)
      .set({
        status: "CLAIMED",
        claimAgentId: builder.agentId,
        claimId: randomUUID(),
        claimExpiresAt: expiresAt,
      })
      .where(eq(task.id, created.id));
    const [listed] = (await listTasks(host, as(owner))).tasks;
    expect(listed?.claim).toEqual({
      agentId: builder.agentId,
      agentName: "claude-1",
      expiresAt: expiresAt.toISOString(),
    });
  });
});

describe("listWorkspaceTasks", () => {
  it("lists the open tasks of the workspace's projects with their names, by project and status", async () => {
    const shop = await createTask(host, as(owner), { ...fields, title: "Shop" });
    tick();
    await createTask(host, as(owner, projectB), { ...fields, title: "Api" });
    tick();
    const done = await createTask(host, as(owner), { ...fields, title: "Gone" });
    await updateTask(host, as(owner), done.id, { version: 1, status: "CANCELLED" });
    const ctx = { workspaceId, member: owner, projects: [projectA, projectB] };

    const all = await listWorkspaceTasks(host, ctx);
    expect(WorkspaceTaskList.parse(all)).toEqual(all);
    expect(all.tasks.map((t) => [t.title, t.projectName])).toEqual([
      ["Api", "acme/api"],
      ["Shop", "acme/shop"],
    ]);
    const onlyA = await listWorkspaceTasks(host, ctx, { project: projectA.projectId });
    expect(onlyA.tasks.map((t) => t.id)).toEqual([shop.id]);
    const cancelled = await listWorkspaceTasks(host, ctx, { status: "CANCELLED" });
    expect(cancelled.tasks.map((t) => t.title)).toEqual(["Gone"]);
    const off = await listWorkspaceTasks(host, { ...ctx, projects: [projectB] });
    expect(off.tasks.map((t) => t.title)).toEqual(["Api"]);
    const error = await refusal(
      listWorkspaceTasks(host, { ...ctx, projects: [projectB] }, { project: projectA.projectId }),
    );
    expect(error.code).toBe("not-found");
  });
});

describe("getTask", () => {
  it("answers revisions and comments newest first with their authors, the timeline oldest first and the pull request", async () => {
    const builder = await seedAgent(projectA, "claude-1");
    await seedPullRequest(projectA, 12);
    const created = await createTask(host, builder, { ...fields, requestId: randomUUID() });
    tick();
    const v2 = await updateTask(host, builder, created.id, {
      version: 1,
      description: "Cards and wallets",
    });
    tick();
    const v3 = await updateTask(host, as(developer), created.id, {
      version: v2.version,
      acceptanceCriteria: "Pays twice",
    });
    tick();
    await commentOnTask(host, as(owner), created.id, { body: "First" });
    tick();
    await commentOnTask(host, as(developer), created.id, { body: "  Second  " });
    tick();
    await updateTask(host, as(owner), created.id, { version: v3.version, status: "READY" });
    await linkPullRequest(host, as(owner), created.id, { number: 12 });
    host.directory.members[workspaceId] = [owner];

    const detail = await getTask(host, as(owner), created.id);
    expect(TaskDetail.parse(detail)).toEqual(detail);
    const agentAuthor = { kind: "agent", agentId: builder.agentId, name: "claude-1" };
    const former = { kind: "member", userId: developer.userId, name: "Former member" };
    expect(detail).toMatchObject({
      description: "Cards and wallets",
      acceptanceCriteria: "Pays twice",
      revision: 3,
      status: "READY",
      creator: agentAuthor,
      pullRequest: {
        number: 12,
        title: "Pull request 12",
        state: "open",
        url: "https://github.com/acme/shop/pull/12",
        updatedAt: "2026-02-28T00:00:00.000Z",
      },
    });
    expect(detail.revisions.map((r) => [r.number, r.author])).toEqual([
      [3, former],
      [2, agentAuthor],
      [1, agentAuthor],
    ]);
    expect(detail.revisions[0]).toMatchObject({
      acceptanceCriteria: "Pays twice",
      createdAt: "2026-03-01T10:00:02.000Z",
    });
    expect(detail.comments.map((c) => [c.body, c.author])).toEqual([
      ["Second", former],
      ["First", { kind: "member", userId: owner.userId, name: "Olga" }],
    ]);
    expect(detail.timeline.map((e) => [e.kind, e.actor, e.message, e.revision])).toEqual([
      ["task.created", agentAuthor, "Task created: Ship checkout", 1],
      ["requirements.changed", agentAuthor, "Requirements changed: Ship checkout", 2],
      ["requirements.changed", former, "Requirements changed: Ship checkout", 3],
      [
        "task.updated",
        { kind: "member", userId: owner.userId, name: "Olga" },
        "Task moved to Ready: Ship checkout",
        3,
      ],
    ]);
  });

  it("shows a host event without an actor and an unreadable payload without a message", async () => {
    const created = await createTask(host, as(owner), fields);
    tick();
    await testDb.db.insert(outboxEvent).values({
      workspaceId,
      projectId: projectA.projectId,
      taskId: created.id,
      kind: "branch.updated",
      payload: { revision: "x" },
      createdAt: new Date(clock),
    });
    const { timeline } = await getTask(host, as(owner), created.id);
    expect(timeline.at(-1)).toMatchObject({
      kind: "branch.updated",
      actor: null,
      message: null,
      revision: null,
    });
  });

  it("answers 404 for another project's task and for an id that isn't one", async () => {
    const elsewhere = await createTask(host, as(owner, projectB), fields);
    for (const id of [elsewhere.id, randomUUID(), "not-an-id"]) {
      const error = await refusal(getTask(host, as(owner), id));
      expect(error.code).toBe("not-found");
      expect(error.message).toBe("There's no such task in this project.");
    }
  });

  it("answers a managed run, which has only its project, the same task", async () => {
    const created = await createTask(host, as(owner), fields);
    expect(await getTask(host, { project: projectA }, created.id)).toEqual(
      await getTask(host, as(owner), created.id),
    );
    await refusal(getTask(host, { project: projectB }, created.id), "not-found");
  });
});

describe("updateTask", () => {
  it("keeps a new revision on a requirements change only, and bumps the version on every edit", async () => {
    const created = await createTask(host, as(owner), fields);
    const same = await updateTask(host, as(owner), created.id, { version: 1, title: fields.title });
    expect(same).toMatchObject({ revision: 1, version: 2 });
    const moved = await updateTask(host, as(owner), created.id, { version: 2, status: "READY" });
    expect(moved).toMatchObject({ revision: 1, version: 3, status: "READY" });
    const revised = await updateTask(host, as(owner), created.id, { version: 3, title: "New" });
    expect(revised).toMatchObject({ revision: 2, version: 4, title: "New" });
    const revisions = await testDb.db
      .select()
      .from(taskRevision)
      .where(eq(taskRevision.taskId, created.id));
    expect(revisions.map((r) => r.number).sort()).toEqual([1, 2]);
    expect((await events(created.id)).map((e) => e.kind)).toEqual([
      "task.created",
      "task.updated",
      "requirements.changed",
    ]);
    // The no-op edit recorded nothing and woke nothing.
    expect(host.enqueued).toHaveLength(3);
  });

  it("refuses an edit from a stale version", async () => {
    const created = await createTask(host, as(owner), fields);
    await updateTask(host, as(owner), created.id, { version: 1, title: "First" });
    const error = await refusal(
      updateTask(host, as(admin), created.id, { version: 1, title: "Second" }),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("This task changed. Reload it and try again.");
    expect((await getTask(host, as(owner), created.id)).title).toBe("First");
  });

  // PGlite has one connection, so these edits run one after the other: real concurrency is held at
  // the database level by the row lock and the UPDATE conditional on the version read.
  it("refuses the second of two edits made from the same version, saving only the first", async () => {
    const created = await createTask(host, as(owner), fields);
    const results = await Promise.allSettled([
      updateTask(host, as(owner), created.id, { version: 1, title: "From Olga" }),
      updateTask(host, as(admin), created.id, { version: 1, title: "From Ari" }),
    ]);
    const saved = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(saved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    const detail = await getTask(host, as(owner), created.id);
    expect(detail).toMatchObject({ version: 2, revision: 2 });
    expect(detail.revisions).toHaveLength(2);
  });

  it("moves along the lifecycle only, in plain English", async () => {
    const created = await createTask(host, as(owner), fields);
    const error = await refusal(
      updateTask(host, as(owner), created.id, { version: 1, status: "DONE" }),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(
      "A task can't move from Backlog to Done. From Backlog it can move to Ready or Cancelled.",
    );
    await updateTask(host, as(owner), created.id, { version: 1, status: "CANCELLED" });
    const final = await refusal(
      updateTask(host, as(owner), created.id, { version: 2, status: "READY" }),
    );
    expect(final.message).toBe("This task is Cancelled, which is final: it can't move to Ready.");
  });

  it("keeps a Done or Cancelled task's requirements as they are, a member's and an agent's edit", async () => {
    const builder = await seedAgent(projectA);
    const cancelled = await createTask(host, builder, {
      ...fields,
      title: "Delivered",
      requestId: randomUUID(),
    });
    await updateTask(host, as(owner), cancelled.id, { version: 1, status: "CANCELLED" });
    const changes = [
      { title: "Renamed" },
      { description: "Rewritten after the work was closed" },
      { acceptanceCriteria: "Something else" },
    ];
    for (const change of changes) {
      const error = await refusal(
        updateTask(host, as(owner), cancelled.id, { version: 2, ...change }),
        "conflict",
      );
      expect(error.message).toBe(
        "This task is Cancelled, which is final: its requirements stay as they are. Create a new task for further work.",
      );
      await refusal(updateTask(host, builder, cancelled.id, { version: 2, ...change }), "conflict");
    }

    // Done too, reached from Review as a member marks it.
    const done = await createTask(host, as(owner), fields);
    await testDb.db.update(task).set({ status: "REVIEW" }).where(eq(task.id, done.id));
    await updateTask(host, as(owner), done.id, { version: 1, status: "DONE" });
    const error = await refusal(
      updateTask(host, as(admin), done.id, { version: 2, title: "Renamed" }),
      "conflict",
    );
    expect(error.message).toMatch(/^This task is Done, which is final/);

    // The same requirements, the task's fields and its assignee may still be given.
    const kept = await updateTask(host, as(owner), done.id, {
      version: 2,
      ...fields,
      labels: ["shipped"],
      assigneeUserId: admin.userId,
    });
    expect(kept).toMatchObject({ status: "DONE", revision: 1, version: 3, labels: ["shipped"] });
    const detail = await getTask(host, as(owner), cancelled.id);
    expect(detail).toMatchObject({ status: "CANCELLED", revision: 1, version: 2 });
    expect(detail.revisions).toHaveLength(1);
  });

  it("changes a claimed task's status only by its claim or by cancelling it, which ends the claim", async () => {
    const builder = await seedAgent(projectA);
    const created = await createTask(host, as(owner), fields);
    await testDb.db
      .update(task)
      .set({
        status: "CLAIMED",
        claimAgentId: builder.agentId,
        claimId: randomUUID(),
        claimExpiresAt: new Date(clock + 900_000),
      })
      .where(eq(task.id, created.id));
    const error = await refusal(
      updateTask(host, as(owner), created.id, { version: 1, status: "READY" }),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/claimed this task/);
    const edited = await updateTask(host, as(owner), created.id, {
      version: 1,
      title: "Clarified",
    });
    expect(edited).toMatchObject({ status: "CLAIMED", revision: 2 });
    const cancelled = await updateTask(host, as(owner), created.id, {
      version: edited.version,
      status: "CANCELLED",
    });
    expect(cancelled).toMatchObject({ status: "CANCELLED", claim: null });
    const [row] = await testDb.db.select().from(task).where(eq(task.id, created.id));
    expect(row).toMatchObject({ claimAgentId: null, claimId: null, claimExpiresAt: null });
  });

  it("lets a member move a task whose claim expired or whose agent was revoked, ending the claim", async () => {
    const builder = await seedAgent(projectA);
    const claim = async (taskId: string, expiresAt: number) =>
      testDb.db
        .update(task)
        .set({
          status: "CLAIMED",
          claimAgentId: builder.agentId,
          claimId: randomUUID(),
          claimExpiresAt: new Date(expiresAt),
        })
        .where(eq(task.id, taskId));

    const expired = await createTask(host, as(owner), fields);
    await claim(expired.id, clock);
    const ready = await updateTask(host, as(owner), expired.id, { version: 1, status: "READY" });
    expect(ready).toMatchObject({ status: "READY", claim: null });
    const [row] = await testDb.db.select().from(task).where(eq(task.id, expired.id));
    expect(row).toMatchObject({ claimAgentId: null, claimId: null, claimExpiresAt: null });

    const revoked = await createTask(host, as(owner), fields);
    await claim(revoked.id, clock + 900_000);
    await testDb.db
      .update(agent)
      .set({ revokedAt: new Date(clock) })
      .where(eq(agent.id, builder.agentId));
    const moved = await updateTask(host, as(owner), revoked.id, {
      version: 1,
      status: "IN_PROGRESS",
    });
    expect(moved).toMatchObject({ status: "IN_PROGRESS", claim: null });
  });

  it("records one event for an edit changing several things", async () => {
    const created = await createTask(host, as(owner), fields);
    // A move and an assignment: the assignment.
    const assigned = await updateTask(host, as(owner), created.id, {
      version: 1,
      status: "READY",
      assigneeUserId: admin.userId,
    });
    const working = await updateTask(host, as(owner), created.id, {
      version: assigned.version,
      status: "IN_PROGRESS",
    });
    const blocked = await updateTask(host, as(owner), created.id, {
      version: working.version,
      status: "BLOCKED",
    });
    // A Blocked task's assignment: still a blocked event.
    const reassigned = await updateTask(host, as(owner), created.id, {
      version: blocked.version,
      assigneeUserId: approver.userId,
    });
    // A requirements change wins over a move and an assignment.
    await updateTask(host, as(owner), created.id, {
      version: reassigned.version,
      title: "Ship it",
      status: "READY",
      assigneeUserId: null,
    });
    expect((await events(created.id)).map((e) => e.kind)).toEqual([
      "task.created",
      "task.assigned",
      "task.updated",
      "task.blocked",
      "task.blocked",
      "requirements.changed",
    ]);
  });

  it("lets an agent edit only the tasks it created, and move them to Backlog or Ready only", async () => {
    const builder = await seedAgent(projectA, "builder");
    const reviewer = await seedAgent(projectA, "reviewer");
    const own = await createTask(host, builder, { ...fields, requestId: randomUUID() });
    const members = await createTask(host, as(owner), fields);

    const theirs = await refusal(
      updateTask(host, builder, members.id, { version: 1, title: "Mine" }),
    );
    expect(theirs.code).toBe("forbidden");
    expect(theirs.message).toBe(
      "An agent can change only the tasks it created. Ask a member to change this one.",
    );
    const peers = await refusal(updateTask(host, reviewer, own.id, { version: 1, title: "Mine" }));
    expect(peers.code).toBe("forbidden");

    const ready = await updateTask(host, builder, own.id, { version: 1, status: "READY" });
    expect(ready.status).toBe("READY");
    const tooFar = await refusal(
      updateTask(host, builder, own.id, { version: 2, status: "IN_PROGRESS" } as never),
    );
    expect(tooFar.fields).toEqual(["status"]);
    const assigning = await refusal(
      updateTask(host, builder, own.id, { version: 2, assigneeUserId: owner.userId } as never),
    );
    expect(assigning.code).toBe("invalid");
    const [event] = (await events(own.id)).slice(-1);
    expect(event).toMatchObject({ kind: "task.updated", actorAgentId: builder.agentId });
  });

  it("passes an agent's requirements through the host's redactor before storing them, never a member's", async () => {
    const builder = await seedAgent(projectA, "builder");
    const secret = fakeToken();
    const leaky = {
      title: `Rotate ${secret}`,
      description: `The key is ${secret}.`,
      acceptanceCriteria: secret,
    };
    const requestId = randomUUID();
    const created = await createTask(host, builder, { ...leaky, requestId });
    const redacted = {
      title: "Rotate [redacted]",
      description: "The key is [redacted].",
      acceptanceCriteria: "[redacted]",
    };
    expect(await getTask(host, as(owner), created.id)).toMatchObject({
      ...redacted,
      revisions: [{ number: 1, ...redacted }],
      timeline: [{ kind: "task.created", message: "Task created: Rotate [redacted]" }],
    });
    // A retry is compared with what was stored, redacted the same way.
    expect((await createTask(host, builder, { ...leaky, requestId })).id).toBe(created.id);

    const other = fakeToken();
    await updateTask(host, builder, created.id, { version: 1, description: `Now ${other}` });
    const updated = await getTask(host, as(owner), created.id);
    expect(updated.description).toBe("Now [redacted]");
    expect(updated.revisions[0]).toMatchObject({ number: 2, description: "Now [redacted]" });

    const members = await createTask(host, as(owner), { ...leaky });
    expect(await getTask(host, as(owner), members.id)).toMatchObject(leaky);
    await updateTask(host, as(owner), members.id, { version: 1, description: `Now ${other}` });
    expect((await getTask(host, as(owner), members.id)).description).toBe(`Now ${other}`);
  });

  it("refuses another project's task, and an agent of another project", async () => {
    const created = await createTask(host, as(owner), fields);
    const error = await refusal(
      updateTask(host, as(owner, projectB), created.id, { version: 1, title: "x" }),
    );
    expect(error.code).toBe("not-found");
    const stranger = await seedAgent(projectB);
    expect((await refusal(updateTask(host, stranger, created.id, { version: 1 }))).code).toBe(
      "not-found",
    );
  });
});

describe("an edit's assignment", () => {
  it("assigns a member of the workspace and unassigns, recording each", async () => {
    const created = await createTask(host, as(owner), fields);
    const assigned = await updateTask(host, as(admin), created.id, {
      version: 1,
      assigneeUserId: approver.userId,
    });
    expect(assigned.assigneeUserId).toBe(approver.userId);
    const unassigned = await updateTask(host, as(admin), created.id, {
      version: 2,
      assigneeUserId: null,
    });
    expect(unassigned.assigneeUserId).toBeNull();
    expect(
      (await events(created.id)).map((e) => (e.payload as { message: string }).message),
    ).toEqual([
      "Task created: Ship checkout",
      "Task assigned: Ship checkout",
      "Task unassigned: Ship checkout",
    ]);
    expect((await events(created.id)).map((e) => e.kind).slice(1)).toEqual([
      "task.assigned",
      "task.assigned",
    ]);
  });

  it("refuses someone outside the workspace", async () => {
    const created = await createTask(host, as(owner), fields);
    const error = await refusal(
      updateTask(host, as(owner), created.id, { version: 1, assigneeUserId: outsiderId }),
    );
    expect(error.code).toBe("invalid");
    expect(error.fields).toEqual(["assigneeUserId"]);
    expect(error.message).toBe(
      "Only a member of this workspace can be assigned a task. Pick one from the list.",
    );
  });
});

describe("commentOnTask", () => {
  it("answers the trimmed comment with its author and records no event", async () => {
    const created = await createTask(host, as(owner), fields);
    tick();
    const comment = await commentOnTask(host, as(developer), created.id, { body: "  Looks good " });
    expect(comment).toMatchObject({
      author: { kind: "member", userId: developer.userId, name: "Dev" },
      body: "Looks good",
      createdAt: "2026-03-01T10:00:01.000Z",
    });
    expect(await events(created.id)).toHaveLength(1);
  });

  it("refuses another project's task and an empty body", async () => {
    const elsewhere = await createTask(host, as(owner, projectB), fields);
    expect((await refusal(commentOnTask(host, as(owner), elsewhere.id, { body: "x" }))).code).toBe(
      "not-found",
    );
    const mine = await createTask(host, as(owner), fields);
    expect(
      (await refusal(commentOnTask(host, as(owner), mine.id, { body: "   " }))).fields,
    ).toEqual(["body"]);
  });
});

describe("linkPullRequest", () => {
  it("links a pull request seen on the project, audited, and unlinks it", async () => {
    await seedPullRequest(projectA, 7);
    const created = await createTask(host, as(owner), fields);
    const linked = await linkPullRequest(host, as(developer), created.id, { number: 7 });
    expect(linked).toMatchObject({ pullRequestNumber: 7, version: 2 });
    expect(host.audits).toEqual([
      {
        actor: { userId: developer.userId },
        entry: {
          workspaceId,
          projectId: projectA.projectId,
          action: "devsync.task.pull_request_linked",
          detail: { taskId: created.id, previousNumber: null, number: 7 },
        },
      },
    ]);
    const again = await linkPullRequest(host, as(developer), created.id, { number: 7 });
    expect(again.version).toBe(2);
    expect(host.audits).toHaveLength(1);
    const unlinked = await linkPullRequest(host, as(developer), created.id, { number: null });
    expect(unlinked).toMatchObject({ pullRequestNumber: null, version: 3 });
    expect(host.audits[1]?.entry.detail).toEqual({
      taskId: created.id,
      previousNumber: 7,
      number: null,
    });
    expect((await getTask(host, as(owner), created.id)).pullRequest).toBeNull();
  });

  it("refuses a pull request not seen on this project, and another project's task", async () => {
    await seedPullRequest(projectB, 7);
    const created = await createTask(host, as(owner), fields);
    const error = await refusal(linkPullRequest(host, as(owner), created.id, { number: 7 }));
    expect(error.code).toBe("not-found");
    expect(error.message).toBe(
      "DevSync hasn't seen pull request #7 on this project's repository. Check the number, or wait for GitHub to report it.",
    );
    const elsewhere = await refusal(
      linkPullRequest(host, as(owner, projectB), created.id, { number: 7 }),
    );
    expect(elsewhere.message).toBe("There's no such task in this project.");
    const [row] = await testDb.db
      .select()
      .from(task)
      .where(and(eq(task.id, created.id), eq(task.projectId, projectA.projectId)));
    expect(row?.pullRequestNumber).toBeNull();
    expect(host.audits).toEqual([]);
  });
});

it("never lets a workspace's project reach another workspace's task", async () => {
  const foreign: ProjectRef = { ...projectA, workspaceId: otherWorkspaceId };
  const created = await createTask(host, as(owner), fields);
  expect((await refusal(getTask(host, as(owner, foreign), created.id))).code).toBe("not-found");
  expect((await listTasks(host, as(owner, foreign))).tasks).toEqual([]);
});

describe("a task's bounded history", () => {
  /** A task of project A with `n` revisions, `comments` comments and `extra` more timeline events. */
  async function longTask(n: number, comments: number, extra: number) {
    const created = await createTask(host, as(owner), fields);
    const scope = { workspaceId, projectId: projectA.projectId, taskId: created.id };
    const at = (i: number) => new Date(clock + (i + 1) * 1000);
    if (n > 1) {
      await testDb.db.insert(taskRevision).values(
        Array.from({ length: n - 1 }, (_, i) => ({
          ...scope,
          number: i + 2,
          ...fields,
          title: `Revision ${i + 2}`,
          authorUserId: owner.userId,
          createdAt: at(i),
        })),
      );
      await testDb.db.update(task).set({ revision: n }).where(eq(task.id, created.id));
    }
    if (comments > 0) {
      await testDb.db.insert(taskComment).values(
        Array.from({ length: comments }, (_, i) => ({
          ...scope,
          authorUserId: owner.userId,
          body: `Comment ${i + 1}`,
          createdAt: at(i),
        })),
      );
    }
    if (extra > 0) {
      await testDb.db.insert(outboxEvent).values(
        Array.from({ length: extra }, (_, i) => ({
          ...scope,
          actorUserId: owner.userId,
          kind: "task.updated",
          payload: { taskId: created.id, message: `Event ${i + 1}` },
          createdAt: at(i),
        })),
      );
    }
    return created;
  }

  it("lists the 50 newest revisions, 100 newest comments and 100 latest events, counting the rest", async () => {
    const created = await longTask(55, 105, 104);
    const detail = await getTask(host, as(owner), created.id);
    expect(TaskDetail.parse(detail)).toEqual(detail);
    expect(detail.revisions).toHaveLength(50);
    expect(detail.revisions[0]?.number).toBe(55);
    expect(detail.revisions.at(-1)?.number).toBe(6);
    expect(detail.revisionsNotShown).toBe(5);
    expect(detail.comments).toHaveLength(100);
    expect(detail.comments[0]?.body).toBe("Comment 105");
    expect(detail.commentsNotShown).toBe(5);
    // Its task.created and 104 more: the latest 100, oldest first.
    expect(detail.timeline).toHaveLength(100);
    expect(detail.timeline.at(-1)?.message).toBe("Event 104");
    expect(detail.timelineNotShown).toBe(5);

    const short = await getTask(host, as(owner), (await longTask(1, 0, 0)).id);
    expect(short).toMatchObject({
      revisionsNotShown: 0,
      commentsNotShown: 0,
      timelineNotShown: 0,
      overlapsNotShown: 0,
    });
  });

  it("lists the 20 oldest of the open tasks sharing its paths, counting the rest", async () => {
    const created = await createTask(host, as(owner), { ...fields, owns: ["src/"] });
    await testDb.db.insert(task).values(
      Array.from({ length: 23 }, (_, i) => ({
        workspaceId,
        projectId: projectA.projectId,
        title: `Neighbour ${i + 1}`,
        description: "",
        acceptanceCriteria: "",
        owns: [`src/part-${i + 1}.ts`],
        createdAt: new Date(clock + (i + 1) * 1000),
        updatedAt: new Date(clock + (i + 1) * 1000),
      })),
    );
    const detail = await getTask(host, as(owner), created.id);
    expect(detail.overlaps).toHaveLength(20);
    expect(detail.overlaps[0]?.task.title).toBe("Neighbour 1");
    expect(detail.overlapsNotShown).toBe(3);
  });

  it("holds at most 200 revisions of a task's requirements, its other fields still changing", async () => {
    const created = await longTask(199, 0, 0);
    const v200 = await updateTask(host, as(owner), created.id, { version: 1, title: "The 200th" });
    expect(v200.revision).toBe(200);
    const error = await refusal(
      updateTask(host, as(owner), created.id, { version: v200.version, title: "The 201st" }),
      "conflict",
    );
    expect(error.message).toBe(
      "This task has 200 revisions of its requirements, the most a task keeps. Create a new task for further changes.",
    );
    const moved = await updateTask(host, as(owner), created.id, {
      version: v200.version,
      title: "The 200th",
      status: "READY",
      labels: ["long"],
    });
    expect(moved).toMatchObject({ revision: 200, status: "READY", labels: ["long"] });
  });

  it("holds at most 500 comments on a task", async () => {
    const created = await longTask(1, 499, 0);
    await commentOnTask(host, as(developer), created.id, { body: "The 500th" });
    const error = await refusal(
      commentOnTask(host, as(developer), created.id, { body: "The 501st" }),
      "conflict",
    );
    expect(error.message).toBe(
      "This task has 500 comments, the most a task keeps. Go on in a new task.",
    );
    const [counted] = await testDb.db
      .select({ n: count() })
      .from(taskComment)
      .where(eq(taskComment.taskId, created.id));
    expect(counted?.n).toBe(500);
  });
});

describe("the paged task lists", () => {
  /** `n` Backlog tasks of `project` updated at the same instant, so only their ids order them. */
  async function manyTasks(n: number, project: ProjectRef = projectA) {
    const at = new Date(clock);
    const rows = await testDb.db
      .insert(task)
      .values(
        Array.from({ length: n }, (_, i) => ({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          title: `Task ${i + 1}`,
          description: "",
          acceptanceCriteria: "",
          creatorUserId: owner.userId,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .returning({ id: task.id });
    return rows.map((row) => row.id);
  }

  it("answers 100 tasks a page, or `limit`, and each next page from its cursor, none twice", async () => {
    const ids = await manyTasks(105);
    tick();
    const newest = await createTask(host, as(owner), { ...fields, title: "Newest" });

    const first = await listTasks(host, as(owner));
    expect(first.tasks).toHaveLength(100);
    expect(first.tasks[0]?.id).toBe(newest.id);
    expect(first.nextCursor).toEqual(expect.any(String));
    const rest = await listTasks(host, as(owner), { cursor: first.nextCursor ?? "" });
    expect(rest.tasks).toHaveLength(6);
    expect(rest.nextCursor).toBeNull();
    const seen = [...first.tasks, ...rest.tasks].map((t) => t.id);
    expect(new Set(seen).size).toBe(106);
    expect(seen.slice(1)).toEqual([...ids].sort().reverse());

    // Smaller pages, filtered, walk the same order.
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTasks(host, as(owner), { status: "BACKLOG", limit: 40, cursor });
      expect(page.tasks.length).toBeLessThanOrEqual(40);
      walked.push(...page.tasks.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(walked).toEqual(seen);
  });

  it("refuses a cursor that isn't one, by its field", async () => {
    for (const cursor of ["bm90IGEgY3Vyc29y", "x", "not a cursor"]) {
      const error = await refusal(listTasks(host, as(owner), { cursor }), "invalid");
      expect(error.fields).toEqual(["cursor"]);
    }
    const limit = await refusal(listTasks(host, as(owner), { limit: 101 }), "invalid");
    expect(limit.fields).toEqual(["limit"]);
  });

  it("pages the workspace's tasks too", async () => {
    await manyTasks(3);
    await manyTasks(2, projectB);
    const ctx = { workspaceId, member: owner, projects: [projectA, projectB] };
    const first = await listWorkspaceTasks(host, ctx, { limit: 4 });
    expect(first.tasks).toHaveLength(4);
    const rest = await listWorkspaceTasks(host, ctx, { limit: 4, cursor: first.nextCursor ?? "" });
    expect(rest).toMatchObject({ nextCursor: null });
    expect(new Set([...first.tasks, ...rest.tasks].map((t) => t.id)).size).toBe(5);
  });
});

describe("an agent's task creates and edits", () => {
  it("count against its 20 signals, questions and answers a minute", async () => {
    const builder = await seedAgent(projectA);
    const create = (requestId: string = randomUUID()) =>
      createTask(host, builder, { ...fields, requestId });
    const first = await create();
    const requestId = randomUUID();
    await create(requestId);
    for (let i = 0; i < 17; i++) await create();
    const edited = await updateTask(host, builder, first.id, { version: 1, title: "Edited" });
    // 20 in the minute: one more of either is refused, and saves nothing.
    const error = await refusal(create(), "rate-limited");
    expect(error.message).toBe(
      "You sent 20 signals, questions, answers and task changes in the last minute, the most an agent may. Wait a minute and try again.",
    );
    await refusal(
      updateTask(host, builder, first.id, { version: edited.version, title: "Again" }),
      "rate-limited",
    );
    // A retry of a task it created is no new task.
    expect((await create(requestId)).title).toBe(fields.title);
    expect((await listTasks(host, as(owner))).tasks).toHaveLength(19);
    // A minute later, it may go on; members aren't counted.
    clock += 60_001;
    await updateTask(host, builder, first.id, { version: edited.version, title: "Again" });
    for (let i = 0; i < 25; i++) await createTask(host, as(owner), fields);
  });
});
