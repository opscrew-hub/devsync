import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("MCP routes inbox reads and acknowledgements to the authenticated agent", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject } = await import("@devsync/core");
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
      "get_project_state", "get_pending_signals", "acknowledge_signal",
    ]);
    const inbox = await call(token, "tools/call", { name: "get_pending_signals", arguments: {} });
    assert.equal(inbox.status, 200);
    assert.equal(JSON.parse((await inbox.json()).result.content[0].text)[0].id, signal.id);
    const ack = await call(token, "tools/call", { name: "acknowledge_signal", arguments: { id: signal.id } });
    assert.equal(ack.status, 200);
    assert.deepEqual(JSON.parse((await ack.json()).result.content[0].text), { id: signal.id, acknowledged: true });
    assert.deepEqual(await pendingSignals(token), []);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
