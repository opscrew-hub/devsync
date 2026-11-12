import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agent inbox persists through credential rotation and scopes acknowledgements", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { changeProjectMember, createProject, DomainError, listProjectAudit } = await import("./index.ts");
  const { registerAgent, publishSignal, publishAgentSignal, pendingSignals, acknowledgeSignal, rotateAgentCredential, revokeAgent, agentProjectState } = await import("./agent-signals.ts");
  const userId = randomUUID();
  const adminId = randomUUID();
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
    const outsider = await registerAgent(userId, other.id, { name: "Outsider", type: "CODEX" });
    const reply = {
      recipientId: claude.agent.id, kind: "review.requested", payload: { message: "Please review." },
      idempotencyKey: randomUUID(), replyToId: signal.id,
    };
    await assert.rejects(publishAgentSignal(outsider.token, reply), status(404));
    await assert.rejects(publishAgentSignal(claude.token, { ...reply, recipientId: codex.agent.id }), status(404));
    const [sent, retry] = await Promise.all([
      publishAgentSignal(rotated.token, reply), publishAgentSignal(rotated.token, reply),
    ]);
    assert.equal(sent.id, retry.id);
    assert.equal(sent.senderAgentId, codex.agent.id);
    assert.equal(sent.hopCount, 1);
    await assert.rejects(publishAgentSignal(rotated.token, { ...reply, idempotencyKey: randomUUID() }), status(409));
    let parent = sent;
    for (let hop = 2; hop <= 4; hop++) {
      const fromClaude = hop % 2 === 0;
      parent = await publishAgentSignal(fromClaude ? claude.token : rotated.token, {
        ...reply, recipientId: fromClaude ? codex.agent.id : claude.agent.id,
        idempotencyKey: randomUUID(), replyToId: parent.id,
      });
      assert.equal(parent.hopCount, hop);
    }
    await assert.rejects(publishAgentSignal(rotated.token, {
      ...reply, idempotencyKey: randomUUID(), replyToId: parent.id,
    }), status(409));
    await revokeAgent(userId, project.id, codex.agent.id);
    await revokeAgent(userId, project.id, codex.agent.id);
    await db.user.create({ data: { id: adminId, name: "Audit reader" } });
    await assert.rejects(listProjectAudit(adminId, project.id), status(404));
    await changeProjectMember(userId, project.id, { userId: adminId, role: "DEVELOPER" });
    await assert.rejects(listProjectAudit(adminId, project.id), status(403));
    await changeProjectMember(userId, project.id, { userId: adminId, role: "ADMIN" });
    await changeProjectMember(userId, project.id, { userId: adminId, role: "ADMIN" });
    const audit = await listProjectAudit(adminId, project.id);
    assert.deepEqual(audit.map(entry => entry.action).sort(), [
      "agent.credential_revoked", "agent.credential_rotated", "agent.registered", "agent.registered",
      "member.access_changed", "member.access_changed", "project.created",
    ]);
    assert.ok(audit.every(entry => entry.actorId === userId && entry.projectId === project.id));
    assert.ok(audit.some(entry => entry.targetId === adminId &&
      JSON.stringify(entry.details).includes('"previousRole":"DEVELOPER"')));
    assert.ok(!JSON.stringify(audit).includes(rotated.token));
    assert.ok(!JSON.stringify(audit).includes("credentialHash"));
    await assert.rejects(pendingSignals(rotated.token), status(401));
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    await db.$disconnect();
  }
});
