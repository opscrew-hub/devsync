import { eq, sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactFiles, createTestDb, fakeHost, fakeToken, type TestDb } from "../testing";
import {
  agent,
  devsyncSchema,
  githubDelivery,
  migrations,
  outboxEvent,
  pullRequest,
  run,
  signal,
  task,
  taskComment,
  taskRevision,
} from ".";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const at = new Date("2026-01-02T03:04:05.000Z");

/** The migrator's journal, and the catalog's list of tables: read through the query builder. */
const journal = devsyncSchema.table("__drizzle_migrations", { hash: text("hash") });
const catalog = pgSchema("information_schema").table("tables", {
  tableSchema: text("table_schema"),
  tableName: text("table_name"),
});

let testDb: TestDb;

beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  await testDb.close();
});

describe("the devsync schema's migration", () => {
  it("is exported for the host with its schema", () => {
    expect(migrations.schema).toBe("devsync");
    expect(migrations.folder).toMatch(/migrations$/);
  });

  it("applies twice, each migration journaled once in devsync.__drizzle_migrations", async () => {
    await testDb.migrate();
    expect(await testDb.db.select().from(journal)).toHaveLength(2);
    const tables = await testDb.db
      .select({ name: catalog.tableName })
      .from(catalog)
      .where(eq(catalog.tableSchema, "devsync"))
      .orderBy(catalog.tableName);
    expect(tables.map((t) => t.name)).toEqual([
      "__drizzle_migrations",
      "agent",
      "github_delivery",
      "outbox_event",
      "pull_request",
      "run",
      "signal",
      "task",
      "task_comment",
      "task_revision",
    ]);
  });

  it("takes a row in each table, with the database's defaults", async () => {
    const { db } = testDb;
    const scope = { workspaceId, projectId };

    const [a] = await db
      .insert(agent)
      .values({
        ...scope,
        name: "builder",
        kind: "CLAUDE",
        tokenHash: fakeToken(),
        expiresAt: at,
        createdAt: at,
      })
      .returning();
    expect(a?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.createdAt).toEqual(at);
    if (!a) throw new Error("no agent");

    const [t] = await db
      .insert(task)
      .values({
        ...scope,
        title: "Add a health check",
        description: "",
        acceptanceCriteria: "",
        creatorUserId: userId,
        updatedAt: at,
      })
      .returning();
    if (!t) throw new Error("no task");
    expect(t).toMatchObject({ status: "BACKLOG", revision: 1, version: 1, claimId: null });

    await db.insert(taskRevision).values({
      ...scope,
      taskId: t.id,
      number: 1,
      title: t.title,
      description: "",
      acceptanceCriteria: "",
      authorUserId: userId,
    });
    await db
      .insert(taskComment)
      .values({ ...scope, taskId: t.id, authorUserId: userId, body: "Hi" });

    const [s] = await db
      .insert(signal)
      .values({
        ...scope,
        recipientAgentId: a.id,
        senderUserId: userId,
        kind: "clarification.requested",
        payload: { message: "Which port?" },
        idempotencyKey: crypto.randomUUID(),
      })
      .returning();
    expect(s).toMatchObject({ hopCount: 0, acknowledgedAt: null });

    const [o] = await db
      .insert(outboxEvent)
      .values({ ...scope, actorUserId: userId, taskId: t.id, kind: "task.created", payload: {} })
      .returning();
    expect(o).toMatchObject({ attempts: 0, processedAt: null });
    expect(o?.availableAt).toBeInstanceOf(Date);

    await db.insert(pullRequest).values({
      ...scope,
      number: 7,
      title: "Health check",
      state: "open",
      url: "https://github.com/acme/app/pull/7",
      headRef: "health",
      headSha: "a".repeat(40),
      sourceUpdatedAt: at,
    });
    await db.insert(githubDelivery).values({ ...scope, deliveryId: "delivery-1", receivedAt: at });

    const [r] = await db
      .insert(run)
      .values({
        ...scope,
        taskId: t.id,
        revision: 1,
        requestedByUserId: userId,
        githubRunId: 9_007_199_254_740,
      })
      .returning();
    expect(r).toMatchObject({ status: "REQUESTED", githubRunId: 9_007_199_254_740 });

    // A task's rows go with it.
    await db.delete(task).where(sql`${task.id} = ${t.id}`);
    for (const table of [taskRevision, taskComment, outboxEvent, run]) {
      expect(await db.select().from(table)).toEqual([]);
    }
    // An agent's signals go with it.
    await db.delete(agent).where(sql`${agent.id} = ${a.id}`);
    expect(await db.select().from(signal)).toEqual([]);
  });

  it("refuses a second pull request with the same number in a project", async () => {
    const row = {
      workspaceId,
      projectId,
      number: 1,
      title: "One",
      state: "open" as const,
      url: "https://github.com/acme/app/pull/1",
      headRef: "one",
      headSha: "b".repeat(40),
      sourceUpdatedAt: at,
    };
    await testDb.db.insert(pullRequest).values(row);
    await expect(testDb.db.insert(pullRequest).values(row)).rejects.toThrow();
  });

  it("keeps one run that hasn't ended per task, and GitHub's run id once per project", async () => {
    const { db } = testDb;
    const scope = { workspaceId, projectId };
    const newTask = async () => {
      const [t] = await db
        .insert(task)
        .values({ ...scope, title: "T", description: "", acceptanceCriteria: "" })
        .returning();
      if (!t) throw new Error("no task");
      return t.id;
    };
    const taskId = await newTask();
    const runOf = (status: (typeof run.$inferInsert)["status"], githubRunId?: number) => ({
      ...scope,
      taskId,
      revision: 1,
      requestedByUserId: userId,
      status,
      githubRunId,
    });

    for (const status of ["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "FAILED"] as const) {
      await db.insert(run).values(runOf(status));
    }
    await db.insert(run).values(runOf("REQUESTED"));
    for (const status of ["REQUESTED", "QUEUED", "RUNNING"] as const) {
      await expect(db.insert(run).values(runOf(status))).rejects.toThrow();
    }
    await db
      .update(run)
      .set({ status: "CANCELLED" })
      .where(sql`${run.taskId} = ${taskId} and ${run.status} = 'REQUESTED'`);
    await db.insert(run).values(runOf("RUNNING", 41));

    const otherTask = await newTask();
    await expect(
      db.insert(run).values({ ...runOf("FAILED", 41), taskId: otherTask }),
    ).rejects.toThrow();
    await db
      .insert(run)
      .values({ ...runOf("FAILED", 41), taskId: otherTask, projectId: crypto.randomUUID() });
  });
});

describe("fakeHost", () => {
  it("records audits and jobs, answers members and projects, and tells a fixed time", async () => {
    const member = { userId, name: "Ana", role: "owner" as const };
    const project = { workspaceId, projectId, fullName: "acme/app", readOnly: false };
    const host = fakeHost(testDb.db, { members: { [workspaceId]: [member] }, projects: [project] });

    expect(host.clock.now().toISOString()).toBe(host.clock.now().toISOString());
    expect(await host.members(workspaceId)).toEqual([member]);
    expect(await host.members(crypto.randomUUID())).toEqual([]);
    expect(await host.project(projectId)).toEqual(project);
    expect(await host.project(crypto.randomUUID())).toBeNull();

    const entry = { workspaceId, projectId, action: "devsync.task.created" as const, detail: {} };
    await host.audit(host.db, { userId }, entry);
    await host.enqueue("devsync.outbox", { projectId });
    expect(host.audits).toEqual([{ actor: { userId }, entry }]);
    expect(host.enqueued).toEqual([{ queue: "devsync.outbox", payload: { projectId } }]);

    host.directory.projects = [];
    expect(await host.project(projectId)).toBeNull();
  });

  it("has a GitHub that records dispatches, serves artifacts and answers scripted failures", async () => {
    const project = { workspaceId, projectId, fullName: "acme/app", readOnly: false };
    const { github } = fakeHost(testDb.db, { projects: [project] });

    expect(await github.setup(projectId, "devsync.yml")).toEqual({
      ok: true,
      workflow: true,
      secrets: ["ANTHROPIC_API_KEY"],
    });
    expect(await github.setup(crypto.randomUUID(), "devsync.yml")).toEqual({
      ok: false,
      failure: "not-found",
    });
    expect(await github.dispatch(projectId, "other.yml", {})).toEqual({
      ok: false,
      failure: "not-found",
    });

    const started = await github.dispatch(projectId, "devsync.yml", { run_id: "r" });
    if (!started.ok) throw new Error("not dispatched");
    expect(started.url).toBe(`https://github.com/acme/app/actions/runs/${started.githubRunId}`);
    expect(github.dispatches).toEqual([
      {
        projectId,
        workflow: "devsync.yml",
        inputs: { run_id: "r" },
        githubRunId: started.githubRunId,
      },
    ]);

    github.artifacts.push({
      githubRunId: started.githubRunId,
      name: "devsync-result",
      files: artifactFiles({ "result.json": "{}" }),
    });
    const read = await github.artifact(projectId, started.githubRunId, "devsync-result");
    expect(read.ok && new TextDecoder().decode(read.files?.get("result.json"))).toBe("{}");
    expect(await github.artifact(projectId, started.githubRunId, "devsync-patch")).toEqual({
      ok: true,
      files: null,
    });
    expect(await github.deleteArtifact(projectId, started.githubRunId, "devsync-result")).toEqual({
      ok: true,
    });
    expect(github.artifacts).toEqual([]);
    expect(github.deleted).toEqual([
      { projectId, githubRunId: started.githubRunId, name: "devsync-result" },
    ]);

    github.fail.dispatch = "workflow-missing";
    expect(await github.dispatch(projectId, "devsync.yml", {})).toEqual({
      ok: false,
      failure: "workflow-missing",
    });
    github.repository.secrets = [];
    expect(await github.setup(projectId, "devsync.yml")).toMatchObject({ secrets: [] });
  });

  it("takes the time it is given", () => {
    const host = fakeHost(testDb.db, { now: "2030-05-06T07:08:09.000Z" });
    expect(host.clock.now().toISOString()).toBe("2030-05-06T07:08:09.000Z");
  });
});

describe("fakeToken", () => {
  it("makes a fresh base64url token each time", () => {
    const one = fakeToken();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fakeToken()).not.toBe(one);
  });
});
