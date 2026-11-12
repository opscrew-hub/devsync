import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("task outbox commits with edits and delivers once across concurrent workers", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, createTask, updateTask } = await import("./index.ts");
  const { registerAgent, pendingSignals } = await import("./agent-signals.ts");
  const { processTaskOutboxEvent } = await import("./task-outbox.ts");
  const owner = randomUUID();
  try {
    await db.user.create({ data: { id: owner, name: "Owner" } });
    const project = await createProject(owner, { name: "Outbox test", description: "" });
    const codex = await registerAgent(owner, project.id, { type: "CODEX", name: "Codex" });
    const claude = await registerAgent(owner, project.id, { type: "CLAUDE", name: "Claude" });
    const task = await createTask(owner, project.id, { title: "Test", description: "", acceptanceCriteria: "" });
    await assert.rejects(updateTask(owner, project.id, task.id, { version: task.version + 1, acceptanceCriteria: "Stale" }));
    await updateTask(owner, project.id, task.id, { version: task.version, acceptanceCriteria: "New criteria" });
    const lateAgent = await registerAgent(owner, project.id, { type: "CODEX", name: "New agent" });
    await db.agent.update({ where: { id: lateAgent.agent.id }, data: { createdAt: new Date(Date.now() + 1000) } });
    assert.equal(await db.outboxEvent.count({ where: { projectId: project.id } }), 2);
    assert.deepEqual(await pendingSignals(codex.token), []);
    const results = await Promise.all(Array.from({ length: 4 }, () => processTaskOutboxEvent(project.id)));
    assert.equal(results.filter(result => result.status === "delivered").length, 2);
    assert.equal((await processTaskOutboxEvent(project.id)).status, "idle");
    for (const agent of [codex, claude]) {
      const inbox = await pendingSignals(agent.token);
      assert.equal(inbox.length, 2);
      assert.deepEqual(inbox.map(signal => signal.kind).sort(), ["requirements.changed", "task.created"]);
      const revision = inbox.find(signal => signal.kind === "requirements.changed");
      assert.deepEqual(revision?.payload, { taskId: task.id, revision: 2, version: 2, message: "requirements.changed: Test" });
    }
    assert.deepEqual(await pendingSignals(lateAgent.token), []);
    await db.$executeRaw`ALTER TABLE "Signal" ADD CONSTRAINT "test_reject_outbox_signal"
      CHECK ("idempotencyKey" NOT LIKE 'outbox:%') NOT VALID`;
    try {
      await createTask(owner, project.id, { title: "Outbox retry fixture", description: "", acceptanceCriteria: "" });
      const retry = await processTaskOutboxEvent(project.id);
      assert.equal(retry.status, "retry", JSON.stringify(retry));
      assert.equal((await processTaskOutboxEvent(project.id)).status, "idle");
      assert.equal((await pendingSignals(codex.token)).length, 2);
    } finally {
      await db.$executeRaw`ALTER TABLE "Signal" DROP CONSTRAINT "test_reject_outbox_signal"`;
    }
    await db.outboxEvent.updateMany({ where: { projectId: project.id, processedAt: null }, data: { availableAt: new Date(0) } });
    assert.equal((await processTaskOutboxEvent(project.id)).status, "delivered");
    assert.equal((await pendingSignals(codex.token)).length, 3);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});
