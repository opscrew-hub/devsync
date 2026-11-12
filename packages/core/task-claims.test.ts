import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("task claims are exclusive, scoped, renewable, and recoverable", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, createTask, updateTask, getTask, DomainError } = await import("./index.ts");
  const { registerAgent } = await import("./agent-signals.ts");
  const { claimTask, renewTaskClaim, releaseTaskClaim } = await import("./task-claims.ts");
  const userId = randomUUID();
  const status = (code: number) => (error: unknown) => error instanceof DomainError && error.status === code;
  try {
    await db.user.create({ data: { id: userId, name: "Owner" } });
    const project = await createProject(userId, { name: "Claims", description: "" });
    const other = await createProject(userId, { name: "Other project", description: "" });
    const agents = await Promise.all([
      registerAgent(userId, project.id, { name: "Codex", type: "CODEX" }),
      registerAgent(userId, project.id, { name: "Claude", type: "CLAUDE" }),
    ]);
    const outsider = await registerAgent(userId, other.id, { name: "Other", type: "CODEX" });
    const task = await createTask(userId, project.id, { title: "Test task", description: "", acceptanceCriteria: "" });
    await assert.rejects(claimTask(agents[0].token, task.id, randomUUID()), status(409));
    await updateTask(userId, project.id, task.id, { status: "READY", version: task.version });
    await assert.rejects(claimTask(outsider.token, task.id, randomUUID()), status(404));
    const claimIds = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(agents.map((agent, index) => claimTask(agent.token, task.id, claimIds[index])));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    const loser = 1 - winner;
    const original = await claimTask(agents[winner].token, task.id, claimIds[winner]);
    await assert.rejects(releaseTaskClaim(agents[loser].token, task.id, claimIds[winner]), status(409));
    await assert.rejects(updateTask(userId, project.id, task.id, { status: "IN_PROGRESS", version: original.version }), status(409));
    await updateTask(userId, project.id, task.id, { acceptanceCriteria: "Revised", version: original.version });
    const renewed = await renewTaskClaim(agents[winner].token, task.id, claimIds[winner]);
    assert.equal(renewed.revision, original.revision + 1);
    assert.ok(renewed.claimExpiresAt >= original.claimExpiresAt);
    await db.task.update({ where: { id: task.id }, data: { claimExpiresAt: new Date(0) } });
    await assert.rejects(renewTaskClaim(agents[winner].token, task.id, claimIds[winner]), status(409));
    const recovered = await claimTask(agents[loser].token, task.id, claimIds[loser]);
    await assert.rejects(releaseTaskClaim(agents[winner].token, task.id, original.claimId), status(409));
    assert.equal((await releaseTaskClaim(agents[loser].token, task.id, recovered.claimId)).status, "READY");
    assert.equal((await getTask(userId, project.id, task.id)).claimId, null);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
