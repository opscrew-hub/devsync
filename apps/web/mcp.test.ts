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
      "get_project_state", "get_pending_signals", "acknowledge_signal", "claim_task", "renew_task_claim", "release_task", "publish_signal", "create_task", "update_task", "report_progress", "report_blocker", "request_review", "submit_review",
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
    const request = JSON.parse(review.content[0].text);
    assert.equal((reviewSignal?.payload as { reviewRequestId?: string }).reviewRequestId, request.id);
    const reviewInput = {
      taskId: current.id, reviewRequestId: request.id, revision: current.revision,
      requestId: randomUUID(), decision: "CHANGES_REQUESTED", message: "Add regression coverage.",
    };
    assert.equal((await mcpTask(token, "submit_review", reviewInput)).isError, true);
    assert.equal((await mcpTask(outsider.token, "submit_review", reviewInput)).isError, true);
    assert.equal((await mcpTask(claude.token, "submit_review", { ...reviewInput, revision: 1 })).isError, true);
    const decision = await mcpTask(claude.token, "submit_review", reviewInput);
    assert.equal(decision.isError, undefined);
    assert.deepEqual(await mcpTask(claude.token, "submit_review", reviewInput), decision);
    assert.equal((await getTask(userId, project.id, current.id)).status, "READY");
    const secondClaim = { taskId: current.id, claimId: randomUUID() };
    assert.equal((await mcpTask(token, "claim_task", secondClaim)).isError, undefined);
    const second = await mcpTask(token, "request_review", {
      ...secondClaim, revision: current.revision, requestId: randomUUID(), message: "Regression coverage added.",
    });
    assert.equal(second.isError, undefined);
    const approvalInput = {
      ...reviewInput, reviewRequestId: JSON.parse(second.content[0].text).id, requestId: randomUUID(),
      decision: "APPROVED", message: "Coverage verified.",
    };
    assert.equal((await mcpTask(claude.token, "submit_review", approvalInput)).isError, undefined);
    assert.equal((await mcpTask(claude.token, "submit_review", { ...approvalInput, requestId: randomUUID() })).isError, true);
    assert.equal((await getTask(userId, project.id, current.id)).status, "REVIEW");
    assert.ok((await listTaskActivity(userId, project.id, current.id)).some(entry => entry.label === "Review approved"));
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId } } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});

test("project stream refreshes on committed writes and closes when access is revoked", {
  timeout: 5000,
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { changeProjectMember, createProject, createTask, createTaskComment } = await import("@devsync/core");
  const { registerAgent, publishSignal, acknowledgeSignal } = await import("@devsync/core/agent-signals");
  const { readProjectRealtimeVersion } = await import("@devsync/core/project-realtime");
  const { projectEventStream } = await import("./lib/project-event-stream.ts");
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const abort = new AbortController();
  try {
    await db.user.createMany({ data: [{ id: ownerId, name: "Owner" }, { id: viewerId, name: "Viewer" }] });
    const project = await createProject(ownerId, { name: "Realtime", description: "" });
    const other = await createProject(ownerId, { name: "Other", description: "" });
    await changeProjectMember(ownerId, project.id, { userId: viewerId, role: "VIEWER" });
    const version = () => readProjectRealtimeVersion(viewerId, project.id);
    assert.equal(await readProjectRealtimeVersion(viewerId, other.id), null);
    const initial = await version();
    const response = projectEventStream(version, abort.signal, 10);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decode = new TextDecoder();
    const next = async () => decode.decode((await reader.read()).value);
    assert.match(await next(), /^retry:/);
    assert.match(await next(), new RegExp("data: " + initial));
    await createTask(ownerId, other.id, { title: "Unrelated", description: "", acceptanceCriteria: "" });
    assert.equal(await version(), initial);
    const task = await createTask(ownerId, project.id, { title: "Realtime task", description: "", acceptanceCriteria: "" });
    assert.match(await next(), new RegExp("data: " + await version()));
    const beforeComment = await version();
    await createTaskComment(ownerId, project.id, task.id, { body: "Update" });
    assert.notEqual(await version(), beforeComment);
    const { agent, token } = await registerAgent(ownerId, project.id, { type: "CODEX", name: "Codex" });
    const delivery = await publishSignal(ownerId, project.id, {
      recipientId: agent.id, kind: "system.warning", payload: { message: "Update" }, idempotencyKey: randomUUID(),
    });
    const beforeAck = await version();
    await acknowledgeSignal(token, delivery.id);
    assert.notEqual(await version(), beforeAck);
    const beforeRollback = await version();
    await assert.rejects(db.$transaction(async tx => {
      await tx.task.update({ where: { id: task.id }, data: { title: "Rolled back" } });
      throw new Error("Abort write");
    }), /Abort write/);
    assert.equal(await version(), beforeRollback);
    await changeProjectMember(ownerId, project.id, { userId: viewerId, role: null });
    let lastEvent = "";
    for (let frame = await reader.read(); !frame.done; frame = await reader.read()) {
      lastEvent = decode.decode(frame.value);
    }
    assert.match(lastEvent, /access-revoked/);
    assert.equal(await version(), null);
  } finally {
    abort.abort();
    await db.project.deleteMany({ where: { members: { some: { userId: ownerId } } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, viewerId] } } });
    await db.$disconnect();
  }
});

test("managed runs require an administrator decision for the current task revision", { skip: process.env.DEVSYNC_TEST_DB !== "1" }, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, createTask, updateTask, changeProjectMember } = await import("@devsync/core");
  const { requestRun, decideRun, listRuns, reserveQueuedRun, releaseRunReservation, startReservedRun, finishReservedRun, expireRunningRuns, renewRunningRun } = await import("@devsync/core/runs");
  const { readProjectRealtimeVersion } = await import("@devsync/core/project-realtime");
  const owner = randomUUID();
  const developer = randomUUID();
  try {
    await db.user.createMany({ data: [{ id: owner, name: "Owner" }, { id: developer, name: "Developer" }] });
    const project = await createProject(owner, { name: "Runs", description: "" });
    await changeProjectMember(owner, project.id, { userId: developer, role: "DEVELOPER" });
    const task = await createTask(owner, project.id, { title: "Run fixture", description: "", acceptanceCriteria: "" });
    const input = { taskId: task.id, agentType: "CODEX" };
    await assert.rejects(requestRun(developer, project.id, input), /Ready/);
    const ready = await updateTask(owner, project.id, task.id, { version: task.version, status: "READY" });
    const beforeRequest = await readProjectRealtimeVersion(owner, project.id);
    const run = await requestRun(developer, project.id, input);
    assert.notEqual(await readProjectRealtimeVersion(owner, project.id), beforeRequest);
    await assert.rejects(requestRun(developer, project.id, input), /pending run/);
    await assert.rejects(decideRun(developer, project.id, run.id, { status: "QUEUED" }), /administrator/);
    await updateTask(owner, project.id, task.id, { version: ready.version, acceptanceCriteria: "Revised" });
    await assert.rejects(decideRun(owner, project.id, run.id, { status: "QUEUED" }), /task changed/);
    await decideRun(owner, project.id, run.id, { status: "CANCELLED" });
    const current = await requestRun(developer, project.id, input);
    await decideRun(owner, project.id, current.id, { status: "QUEUED" });
    const queued = (await listRuns(owner, project.id, task.id)).find(item => item.id === current.id);
    assert.equal(queued?.status, "QUEUED");
    assert.ok(!Object.hasOwn(queued!, "dispatchToken"));
    assert.equal(await reserveQueuedRun("CLAUDE"), null);
    const reservations = await Promise.all([reserveQueuedRun("CODEX"), reserveQueuedRun("CODEX")]);
    const active = reservations.filter(item => item !== null);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, current.id);
    await db.agentRun.update({ where: { id: current.id }, data: { dispatchExpiresAt: new Date(0) } });
    const recovered = await reserveQueuedRun("CODEX");
    assert.ok(recovered);
    assert.notEqual(recovered.dispatchToken, active[0].dispatchToken);
    assert.equal(await releaseRunReservation(current.id, active[0].dispatchToken), false);
    assert.equal(await releaseRunReservation(current.id, recovered.dispatchToken), true);
    const next = await reserveQueuedRun("CODEX");
    assert.ok(next);
    assert.equal(await startReservedRun(current.id, recovered.dispatchToken), false);
    assert.equal(await startReservedRun(current.id, next.dispatchToken), true);
    const beforeHeartbeat = await readProjectRealtimeVersion(owner, project.id);
    assert.ok(await renewRunningRun(current.id, next.dispatchToken));
    assert.equal(await readProjectRealtimeVersion(owner, project.id), beforeHeartbeat);
    assert.equal(await renewRunningRun(current.id, recovered.dispatchToken), null);
    assert.equal(await finishReservedRun(current.id, recovered.dispatchToken, "SUCCEEDED"), false);
    await decideRun(owner, project.id, current.id, { status: "CANCELLED" });
    assert.equal(await finishReservedRun(current.id, next.dispatchToken, "SUCCEEDED"), false);
    assert.equal(await renewRunningRun(current.id, next.dispatchToken), null);
    const retry = await requestRun(developer, project.id, input);
    await decideRun(owner, project.id, retry.id, { status: "QUEUED" });
    const reserved = await reserveQueuedRun("CODEX");
    assert.ok(reserved);
    assert.equal(await startReservedRun(retry.id, reserved.dispatchToken), true);
    await db.agentRun.update({ where: { id: retry.id }, data: { dispatchExpiresAt: new Date(0) } });
    assert.equal(await finishReservedRun(retry.id, reserved.dispatchToken, "SUCCEEDED"), false);
    assert.equal(await renewRunningRun(retry.id, reserved.dispatchToken), null);
    assert.equal(await expireRunningRuns(), 1);
    assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: retry.id } })).status, "FAILED");
    const stale = await requestRun(developer, project.id, input);
    await decideRun(owner, project.id, stale.id, { status: "QUEUED" });
    const lease = await reserveQueuedRun("CODEX");
    assert.ok(lease);
    assert.equal(await startReservedRun(stale.id, lease.dispatchToken), true);
    const latest = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    await updateTask(owner, project.id, task.id, { version: latest.version, acceptanceCriteria: "Changed mid-run" });
    assert.equal(await renewRunningRun(stale.id, lease.dispatchToken), null);
    assert.equal(await finishReservedRun(stale.id, lease.dispatchToken, "SUCCEEDED"), false);
    assert.equal(await finishReservedRun(stale.id, lease.dispatchToken, "FAILED"), true);
    assert.equal(await reserveQueuedRun("CODEX"), null);
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: { in: [owner, developer] } } });
    await db.$disconnect();
  }
});