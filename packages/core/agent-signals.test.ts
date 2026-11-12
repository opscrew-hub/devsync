import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agent inbox persists through credential rotation and scopes acknowledgements", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, DomainError } = await import("./index.ts");
  const { registerAgent, publishSignal, pendingSignals, acknowledgeSignal, rotateAgentCredential, revokeAgent, agentProjectState } = await import("./agent-signals.ts");
  const userId = randomUUID();
  const status = (code: number) => (error: unknown) => error instanceof DomainError && error.status === code;
  try {
    await db.user.create({ data: { id: userId, name: "Owner" } });
    const project = await createProject(userId, { name: "Inbox test", description: "" });
    const other = await createProject(userId, { name: "Other project", description: "" });
    const codex = await registerAgent(userId, project.id, { name: "Codex", type: "CODEX" });
    const claude = await registerAgent(userId, project.id, { name: "Claude", type: "CLAUDE" });
    const input = { recipientId: codex.agent.id, kind: "review.requested", payload: { message: "Review the task." }, idempotencyKey: randomUUID() };
    await assert.rejects(publishSignal(userId, other.id, input), status(404));
    const signal = await publishSignal(userId, project.id, input);
    assert.equal((await publishSignal(userId, project.id, input)).id, signal.id);
    await assert.rejects(publishSignal(userId, project.id, { ...input, kind: "system.warning" }), status(409));
    assert.deepEqual(await pendingSignals(claude.token), []);
    await assert.rejects(acknowledgeSignal(claude.token, signal.id), status(404));
    const rotated = await rotateAgentCredential(userId, project.id, codex.agent.id);
    await assert.rejects(pendingSignals(codex.token), status(401));
    assert.deepEqual((await pendingSignals(rotated.token)).map(signal => signal.id), [signal.id]);
    assert.equal((await agentProjectState(rotated.token)).id, project.id);
    await acknowledgeSignal(rotated.token, signal.id);
    await acknowledgeSignal(rotated.token, signal.id);
    assert.deepEqual(await pendingSignals(rotated.token), []);
    await revokeAgent(userId, project.id, codex.agent.id);
    await assert.rejects(pendingSignals(rotated.token), status(401));
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
