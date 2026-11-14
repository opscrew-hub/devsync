import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outboxEvent } from "../db";
import { createTestDb, type FakeHost, fakeHost, type TestDb } from "../testing";
import { outbox } from "./outbox";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const at = new Date("2026-02-03T04:05:06.000Z");

let testDb: TestDb;
let host: FakeHost;

beforeEach(async () => {
  testDb = await createTestDb();
  host = fakeHost(testDb.db);
});

afterEach(async () => {
  await testDb.close();
});

describe("outbox.record", () => {
  it("inserts the event in the caller's transaction, due at once, with its actor", async () => {
    const row = await testDb.db.transaction((tx) =>
      outbox.record(tx, {
        workspaceId,
        projectId,
        actor: { userId },
        kind: "task.updated",
        payload: { message: "Task moved to Ready: Ship" },
        at,
      }),
    );
    expect(row).toMatchObject({
      workspaceId,
      projectId,
      actorUserId: userId,
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
  });

  it("records nothing when the change's transaction rolls back", async () => {
    await expect(
      testDb.db.transaction(async (tx) => {
        await outbox.record(tx, {
          workspaceId,
          projectId,
          actor: null,
          kind: "task.updated",
          payload: {},
          at,
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await testDb.db.select().from(outboxEvent)).toEqual([]);
  });
});

describe("outbox.wake", () => {
  it("enqueues devsync.outbox for the project", async () => {
    await outbox.wake(host, projectId);
    expect(host.enqueued).toEqual([
      { queue: "devsync.outbox", payload: { projectId }, options: undefined },
    ]);
  });
});
