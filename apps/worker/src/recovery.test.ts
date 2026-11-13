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
