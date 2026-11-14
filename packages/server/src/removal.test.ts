import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agent,
  githubDelivery,
  outboxEvent,
  pullRequest,
  run,
  signal,
  task,
  taskComment,
  taskRevision,
} from "./db";
import type { DevSyncDb } from "./host";
import { removeMember, removeProject, removeWorkspace } from "./removal";
import { createTestDb, fakeToken, type TestDb } from "./testing";

const workspaceId = "00000000-0000-4000-8000-0000000000a1";
const otherWorkspaceId = "00000000-0000-4000-8000-0000000000a2";
const projectA = "00000000-0000-4000-8000-0000000000b1";
const projectB = "00000000-0000-4000-8000-0000000000b2";
const projectC = "00000000-0000-4000-8000-0000000000b3";
const userId = "00000000-0000-4000-8000-0000000000c1";
const at = new Date("2026-03-01T10:00:00.000Z");

const TABLES = {
  agent,
  githubDelivery,
  outboxEvent,
  pullRequest,
  run,
  signal,
  task,
  taskComment,
  taskRevision,
};

let testDb: TestDb;

beforeEach(async () => {
  testDb = await createTestDb();
  await seed(testDb.db, workspaceId, projectA);
  await seed(testDb.db, workspaceId, projectB);
  await seed(testDb.db, otherWorkspaceId, projectC);
});

afterEach(async () => {
  await testDb.close();
});

/** One row in every DevSync table for the project, linked as the domain links them. */
async function seed(db: DevSyncDb, workspace: string, project: string) {
  const scope = { workspaceId: workspace, projectId: project };
  const [a] = await db
    .insert(agent)
    .values({ ...scope, name: "builder", kind: "CLAUDE", tokenHash: fakeToken(), expiresAt: at })
    .returning();
  const [t] = await db
    .insert(task)
    .values({
      ...scope,
      title: "T",
      description: "",
      acceptanceCriteria: "",
      creatorUserId: userId,
      assigneeUserId: userId,
      claimAgentId: a?.id,
    })
    .returning();
  if (!a || !t) throw new Error("not seeded");
  await db.insert(taskRevision).values({
    ...scope,
    taskId: t.id,
    number: 1,
    title: "T",
    description: "",
    acceptanceCriteria: "",
    authorUserId: userId,
  });
  await db.insert(taskComment).values({ ...scope, taskId: t.id, authorUserId: userId, body: "c" });
  const [request] = await db
    .insert(outboxEvent)
    .values({ ...scope, taskId: t.id, actorAgentId: a.id, kind: "review.requested", payload: {} })
    .returning();
  await db.insert(outboxEvent).values({
    ...scope,
    taskId: t.id,
    reviewRequestId: request?.id,
    kind: "review.approved",
    payload: {},
  });
  const [first] = await db
    .insert(signal)
    .values({
      ...scope,
      recipientAgentId: a.id,
      senderAgentId: a.id,
      kind: "system.warning",
      payload: {},
      idempotencyKey: randomUUID(),
    })
    .returning();
  await db.insert(signal).values({
    ...scope,
    recipientAgentId: a.id,
    senderUserId: userId,
    replyToId: first?.id,
    kind: "clarification.answered",
    payload: {},
    idempotencyKey: randomUUID(),
  });
  await db.insert(pullRequest).values({
    ...scope,
    number: 1,
    title: "PR",
    state: "open",
    url: "https://github.com/acme/shop/pull/1",
    headRef: "main",
    headSha: "b".repeat(40),
    sourceUpdatedAt: at,
  });
  await db.insert(githubDelivery).values({ ...scope, deliveryId: randomUUID() });
  await db.insert(run).values({ ...scope, taskId: t.id, revision: 1, requestedByUserId: userId });
}

/** The number of rows each table holds for the project. */
async function counts(project: string) {
  const result: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    result[name] = (
      await testDb.db.select().from(table).where(eq(table.projectId, project))
    ).length;
  }
  return result;
}

const seeded = {
  agent: 1,
  githubDelivery: 1,
  outboxEvent: 2,
  pullRequest: 1,
  run: 1,
  signal: 2,
  task: 1,
  taskComment: 1,
  taskRevision: 1,
};
const none = Object.fromEntries(Object.keys(seeded).map((name) => [name, 0]));

describe("removeProject", () => {
  it("deletes every DevSync row of the project, and only its", async () => {
    expect(await counts(projectA)).toEqual(seeded);
    await removeProject(testDb.db, projectA);
    expect(await counts(projectA)).toEqual(none);
    expect(await counts(projectB)).toEqual(seeded);
    expect(await counts(projectC)).toEqual(seeded);
  });
});

describe("removeWorkspace", () => {
  it("deletes every DevSync row of each of the workspace's projects, and only theirs", async () => {
    await removeWorkspace(testDb.db, workspaceId);
    expect(await counts(projectA)).toEqual(none);
    expect(await counts(projectB)).toEqual(none);
    expect(await counts(projectC)).toEqual(seeded);
  });

  it("runs inside the host's removal transaction, undone with it", async () => {
    await expect(
      testDb.db.transaction(async (tx) => {
        await removeWorkspace(tx, workspaceId);
        throw new Error("the host's removal failed");
      }),
    ).rejects.toThrow("the host's removal failed");
    expect(await counts(projectA)).toEqual(seeded);
  });
});

describe("removeMember", () => {
  it("unassigns the member from the workspace's tasks only, bumping their versions", async () => {
    await removeMember(testDb.db, workspaceId, userId);
    const rows = await testDb.db
      .select({ projectId: task.projectId, assignee: task.assigneeUserId, version: task.version })
      .from(task)
      .orderBy(task.projectId);
    expect(rows).toEqual([
      { projectId: projectA, assignee: null, version: 2 },
      { projectId: projectB, assignee: null, version: 2 },
      { projectId: projectC, assignee: userId, version: 1 },
    ]);
  });

  it("keeps the runs they asked for, with their id", async () => {
    await removeMember(testDb.db, workspaceId, userId);
    expect(await counts(projectA)).toMatchObject({ run: 1 });
    const rows = await testDb.db.select().from(run).where(eq(run.projectId, projectA));
    expect(rows.map((r) => r.requestedByUserId)).toEqual([userId]);
  });
});
