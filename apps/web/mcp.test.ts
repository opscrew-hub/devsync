import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("MCP routes inbox reads and acknowledgements to the authenticated agent", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, createTask, getTask, updateTask } = await import("@devsync/core");
  const { listTaskActivity } = await import("@devsync/core/task-activity");
  const { processTaskOutboxEvent } = await import("@devsync/core/task-outbox");
  const { registerAgent, publishSignal, pendingSignals } = await import("@devsync/core/agent-signals");
  const { POST } = await import("./app/api/mcp/route.ts");
  const userId = randomUUID();
  const call = (token: string, method: string, params: object) => POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));

  try {
    await db.user.create({ data: { id: userId, name: "MCP test" } });
    const project = await createProject(userId, { name: "MCP test", description: "" });
    const { agent, token } = await registerAgent(userId, project.id, { name: "Codex", type: "CODEX" });
    const signal = await publishSignal(userId, project.id, {
      recipientId: agent.id, kind: "review.requested",
      payload: { message: "Review the task." }, idempotencyKey: randomUUID(),
    });
    assert.equal((await call("invalid", "tools/list", {})).status, 401);
    const tools = await call(token, "tools/list", {});
    assert.equal(tools.status, 200);
    assert.deepEqual((await tools.json()).result.tools.map((tool: { name: string }) => tool.name), [
      "get_project_state", "get_pending_signals", "acknowledge_signal", "claim_task", "renew_task_claim", "release_task", "publish_signal", "create_task", "update_task", "report_progress", "report_blocker", "request_review",
    ]);
    const inbox = await call(token, "tools/call", { name: "get_pending_signals", arguments: {} });
    assert.equal(inbox.status, 200);
    assert.equal(JSON.parse((await inbox.json()).result.content[0].text)[0].id, signal.id);
    const ack = await call(token, "tools/call", { name: "acknowledge_signal", arguments: { id: signal.id } });
    assert.equal(ack.status, 200);
    assert.deepEqual(JSON.parse((await ack.json()).result.content[0].text), { id: signal.id, acknowledged: true });
    assert.deepEqual(await pendingSignals(token), []);
    const claude = await registerAgent(userId, project.id, { name: "Claude", type: "CLAUDE" });
    const sent = await call(token, "tools/call", { name: "publish_signal", arguments: {
      recipientId: claude.agent.id, kind: "clarification.answered", payload: { message: "Reviewed." },
      idempotencyKey: randomUUID(), replyToId: signal.id,
    } });
    assert.equal(sent.status, 200);
    assert.equal(JSON.parse((await sent.json()).result.content[0].text).senderAgentId, agent.id);
    assert.equal((await pendingSignals(claude.token))[0].hopCount, 1);
    const task = await createTask(userId, project.id, { title: "Claim via MCP", description: "", acceptanceCriteria: "" });
    await updateTask(userId, project.id, task.id, { status: "READY", version: task.version });
    const argumentsForClaim = { taskId: task.id, claimId: randomUUID() };
    const claimed = await call(token, "tools/call", { name: "claim_task", arguments: argumentsForClaim });
    assert.equal(JSON.parse((await claimed.json()).result.content[0].text).status, "CLAIMED");
    const released = await call(token, "tools/call", { name: "release_task", arguments: argumentsForClaim });
    assert.equal(JSON.parse((await released.json()).result.content[0].text).status, "READY");

    const mcpTask = async (credential: string, name: string, args: object) => {
      const response = await call(credential, "tools/call", { name, arguments: args });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const createInput = { requestId: randomUUID(), title: "Agent handoff", description: "", acceptanceCriteria: "Original" };
    const created = JSON.parse((await mcpTask(claude.token, "create_task", createInput)).content[0].text);
    assert.equal(created.creatorAgentId, claude.agent.id);
    const duplicate = JSON.parse((await mcpTask(claude.token, "create_task", createInput)).content[0].text);
    assert.equal(duplicate.id, created.id);
    assert.equal((await mcpTask(claude.token, "create_task", { ...createInput, title: "Different" })).isError, true);
    const change = { taskId: created.id, version: created.version, status: "READY", acceptanceCriteria: "Revised" };
    assert.equal((await mcpTask(token, "update_task", change)).isError, true);
    const outside = await createProject(userId, { name: "Outside", description: "" });
    const outsider = await registerAgent(userId, outside.id, { name: "Outside", type: "CLAUDE" });
    assert.match((await mcpTask(outsider.token, "update_task", change)).content[0].text, /Task not found/);
    const edited = JSON.parse((await mcpTask(claude.token, "update_task", change)).content[0].text);
    assert.equal(edited.revision, 2);
    assert.equal(edited.status, "READY");
    assert.equal((await mcpTask(claude.token, "update_task", change)).isError, true);
    while ((await processTaskOutboxEvent(project.id)).status === "delivered") { /* drain project events */ }
    const handoff = (await pendingSignals(token)).filter(item => item.senderAgentId === claude.agent.id);
    assert.deepEqual(handoff.map(item => item.kind).sort(), ["requirements.changed", "task.created"]);
    const claim = { taskId: edited.id, claimId: randomUUID() };
    await mcpTask(token, "claim_task", claim);
    const progress = { ...claim, revision: edited.revision, requestId: randomUUID(), message: "Tests underway." };
    assert.equal((await mcpTask(claude.token, "report_progress", progress)).isError, true);
    assert.equal((await mcpTask(token, "report_progress", { ...progress, revision: 1 })).isError, true);
    const report = await mcpTask(token, "report_progress", progress);
    assert.equal(report.isError, undefined);
    assert.deepEqual(await mcpTask(token, "report_progress", progress), report);
    const blocker = { ...progress, requestId: randomUUID(), message: "Waiting for a fixture." };
    const blocked = await mcpTask(token, "report_blocker", blocker);
    assert.equal(blocked.isError, undefined);
    assert.deepEqual(await mcpTask(token, "report_blocker", blocker), blocked);
    let current = await getTask(userId, project.id, edited.id);
    assert.equal(current.status, "BLOCKED");
    assert.equal(current.claimId, null);
    assert.equal((await mcpTask(token, "request_review", { ...progress, requestId: randomUUID() })).isError, true);
    current = { ...current, ...await updateTask(userId, project.id, edited.id, { version: current.version, status: "READY" }) };
    const reclaimed = { taskId: current.id, claimId: randomUUID() };
    await mcpTask(token, "claim_task", reclaimed);
    const review = await mcpTask(token, "request_review", {
      ...reclaimed, revision: current.revision, requestId: randomUUID(), message: "Ready for review.",
    });
    assert.equal(review.isError, undefined);
    assert.equal((await getTask(userId, project.id, edited.id)).status, "REVIEW");
    assert.equal((await listTaskActivity(userId, project.id, edited.id)).length, 3);
    while ((await processTaskOutboxEvent(project.id)).status === "delivered") { /* drain project events */ }
    const reviewSignal = (await pendingSignals(claude.token)).find(item => item.kind === "review.requested");
    assert.equal(reviewSignal?.senderAgentId, agent.id);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
