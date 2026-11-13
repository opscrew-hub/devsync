import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { db } from "@devsync/db";
import { createProject, createTask } from "@devsync/core";

test("worker marks expired runs failed on startup", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
  timeout: 15000,
}, async () => {
  const owner = randomUUID();
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    await db.user.create({ data: { id: owner, name: "Worker test" } });
    const project = await createProject(owner, { name: "Recovery", description: "" });
    const task = await createTask(owner, project.id, { title: "Recovery fixture", description: "", acceptanceCriteria: "" });
    const run = await db.agentRun.create({ data: {
      projectId: project.id, taskId: task.id, requestedById: owner, agentType: "CODEX",
      status: "RUNNING", revision: task.revision, dispatchToken: randomUUID(), dispatchExpiresAt: new Date(0),
    } });
    worker = spawn(process.execPath, ["src/outbox.ts", "--recover-once"], { stdio: "ignore" });
    const exited = new Promise(resolve => worker!.once("close", resolve));
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const current = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
        if (current.status === "FAILED") {
          assert.ok(current.finishedAt);
          assert.equal(current.dispatchToken, null);
          return;
        }
        assert.equal(worker.exitCode, null, "Worker exited before recovering the run");
        await setTimeout(100);
      }
      assert.fail("Worker did not recover the expired run");
    } finally {
      worker.kill();
      await exited;
    }
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});

test("executor consumes an approved run and persists its outcome", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { executeNextRun } = await import("./managed-run.ts");
  const { requestRun, decideRun } = await import("@devsync/core/runs");
  const owner = randomUUID();
  try {
    await db.user.create({ data: { id: owner, name: "Executor test" } });
    const project = await createProject(owner, { name: "Executor", description: "" });
    const task = await createTask(owner, project.id, { title: "Executor fixture", description: "", acceptanceCriteria: "" });
    await db.task.update({ where: { id: task.id }, data: { status: "READY" } });
    const run = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, run.id, { status: "QUEUED" });
    await assert.rejects(executeNextRun("CLAUDE", async () => {
      assert.fail("Adapter ran without a linked repository");
    }, new AbortController().signal), /linked repository/);
    assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status, "FAILED");
    await db.githubRepository.create({ data: {
      projectId: project.id, installationId: 23456n, repositoryId: 34567n, fullName: "fixture/devsync",
    } });
    const ready = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, ready.id, { status: "QUEUED" });
    const executed = await executeNextRun("CLAUDE", async (work, signal) => {
      assert.equal(work.id, ready.id);
      assert.equal(work.repository, "fixture/devsync");
      assert.equal(work.title, "Executor fixture");
      assert.equal(work.revision, task.revision);
      assert.equal(signal.aborted, false);
      return { changes: [{ path: "fixture.txt", status: " M" }], baseCommit: "a".repeat(40) };
    }, new AbortController().signal);
    assert.equal(executed, true);
    const finished = await db.agentRun.findUniqueOrThrow({ where: { id: ready.id } });
    assert.equal(finished.status, "SUCCEEDED");
    assert.equal(finished.dispatchToken, null);
    assert.equal(finished.baseCommit, "a".repeat(40));
    assert.deepEqual(finished.changes, [{ path: "fixture.txt", status: " M" }]);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});
