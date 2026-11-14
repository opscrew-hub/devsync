import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const stale = await db.agentRun.create({ data: {
      projectId: project.id, taskId: (await createTask(owner, project.id, {
        title: "Stale fixture", description: "", acceptanceCriteria: "",
      })).id, requestedById: owner, agentType: "CODEX", status: "QUEUED", revision: 1,
    } });
    await db.task.update({ where: { id: stale.taskId }, data: { revision: 2 } });
    const terminal = await createTask(owner, project.id, { title: "Cancelled fixture", description: "", acceptanceCriteria: "" });
    const terminalRun = await db.agentRun.create({ data: {
      projectId: project.id, taskId: terminal.id, requestedById: owner, agentType: "CODEX", status: "QUEUED", revision: terminal.revision,
    } });
    await db.task.update({ where: { id: terminal.id }, data: { status: "CANCELLED" } });
    worker = spawn(process.execPath, ["src/outbox.ts", "--recover-once"], { stdio: "ignore" });
    const exited = new Promise(resolve => worker!.once("close", resolve));
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const current = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
        if (current.status === "FAILED") {
          assert.equal(await exited, 0);
          assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: stale.id } })).status, "FAILED");
          assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: terminalRun.id } })).status, "FAILED");
          assert.equal(current.failureReason, "LEASE_EXPIRED");
          assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: stale.id } })).failureReason, "REVISION_CHANGED");
          assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: terminalRun.id } })).failureReason, "TASK_CLOSED");
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
  const { executeNextRun, withManagedCheckout } = await import("./managed-run.ts");
  const { requestRun, decideRun, getRunPatch, claimRunDraftPublication, recordRunDraftPullRequest } = await import("@devsync/core/runs");
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
    const failed = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failureReason, "EXECUTION_FAILED");
    await db.githubRepository.create({ data: {
      projectId: project.id, installationId: 23456n, repositoryId: 34567n, fullName: "fixture/devsync",
    } });
    const ready = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, ready.id, { status: "QUEUED" });
    const source = await mkdtemp(join(tmpdir(), "devsync-run-fixture-"));
    let commit: string;
    let executed: boolean;
    try {
      const git = (...args: string[]) => execFileSync("git", [
        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
      ], { cwd: source, encoding: "utf8" });
      git("init", "-q");
      await writeFile(join(source, "fixture.txt"), "original\n");
      git("add", "fixture.txt");
      git("commit", "-qm", "Fixture");
      commit = git("rev-parse", "HEAD").trim();
      const execute = withManagedCheckout(async () => ({ repository: source, commit }), async (work, checkout, signal) => {
        assert.equal(work.id, ready.id);
        assert.equal(work.repository, "fixture/devsync");
        assert.equal(work.revision, task.revision);
        assert.equal(checkout.commit, commit);
        signal.throwIfAborted();
        await writeFile(join(checkout.directory, "fixture.txt"), "updated\n");
        return { inputTokens: 120, outputTokens: 30 };
      });
      executed = await executeNextRun("CLAUDE", execute, new AbortController().signal, undefined, undefined, undefined, undefined, true);
    } finally {
      await rm(source, { recursive: true, force: true, maxRetries: 3 });
    }
    assert.equal(executed, true);
    const finished = await db.agentRun.findUniqueOrThrow({ where: { id: ready.id } });
    assert.equal(finished.status, "SUCCEEDED");
    assert.equal(finished.dispatchToken, null);
    assert.match((await getRunPatch(owner, project.id, ready.id)).patch, /\+updated/);
    await assert.rejects(getRunPatch(randomUUID(), project.id, ready.id), /not found/);
    assert.deepEqual(finished.tokenUsage, { inputTokens: 120, outputTokens: 30 });
    assert.equal(finished.baseCommit, commit);
    assert.deepEqual(finished.changes, [{ path: "fixture.txt", status: " M" }]);
    const claims = await Promise.all([claimRunDraftPublication(), claimRunDraftPublication()]);
    const claimed = claims.filter(job => job !== null);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, ready.id);
    assert.equal(claimed[0]?.patch, finished.patch);
    await db.agentRun.update({ where: { id: ready.id }, data: { draftRetryAt: new Date(0) } });
    const retry = await claimRunDraftPublication();
    assert.ok(retry);
    assert.deepEqual(retry, claimed[0]);
    const url = "https://github.com/fixture/devsync/pull/1";
    assert.equal(await recordRunDraftPullRequest(retry, commit, url), true);
    assert.equal(await claimRunDraftPublication(), null);
    assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: ready.id } })).draftPullRequestUrl, url);
    const timed = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, timed.id, { status: "QUEUED" });
    await assert.rejects(executeNextRun("CLAUDE", async (_, signal) => {
      await setTimeout(10000, undefined, { signal });
    }, new AbortController().signal, 100), { name: "AbortError" });
    const timedOut = await db.agentRun.findUniqueOrThrow({ where: { id: timed.id } });
    assert.equal(timedOut.status, "FAILED");
    assert.equal(timedOut.failureReason, "TIME_LIMIT");
    const overBudget = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, overBudget.id, { status: "QUEUED" });
    await executeNextRun("CLAUDE", async () => ({
      changes: [], baseCommit: "a".repeat(40), patch: "do not retain",
      tokenUsage: { inputTokens: 90, outputTokens: 20 },
    }), new AbortController().signal, undefined, undefined, 100);
    const rejected = await db.agentRun.findUniqueOrThrow({ where: { id: overBudget.id } });
    assert.equal(rejected.status, "FAILED");
    assert.equal(rejected.failureReason, "TOKEN_BUDGET");
    assert.deepEqual(rejected.tokenUsage, { inputTokens: 90, outputTokens: 20 });
    assert.equal(rejected.patch, null);
    const cancelled = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, cancelled.id, { status: "QUEUED" });
    await executeNextRun("CLAUDE", async work => {
      assert.equal(work.id, cancelled.id);
      await decideRun(owner, project.id, work.id, { status: "CANCELLED" });
      return { changes: [], baseCommit: "a".repeat(40), patch: "late result" };
    }, new AbortController().signal);
    const stopped = await db.agentRun.findUniqueOrThrow({ where: { id: cancelled.id } });
    assert.equal(stopped.status, "CANCELLED");
    assert.equal(stopped.patch, null);
    assert.equal(stopped.dispatchToken, null);
    const interrupted = await requestRun(owner, project.id, { taskId: task.id, agentType: "CLAUDE" });
    await decideRun(owner, project.id, interrupted.id, { status: "QUEUED" });
    let observedAbort = false;
    await assert.rejects(executeNextRun("CLAUDE", async (work, signal) => {
      assert.equal(work.id, interrupted.id);
      await decideRun(owner, project.id, work.id, { status: "CANCELLED" });
      try {
        await setTimeout(1000, undefined, { signal });
      } finally {
        observedAbort = signal.aborted;
      }
    }, new AbortController().signal, 5000, undefined, undefined, 25), { name: "AbortError" });
    assert.equal(observedAbort, true);
    assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: interrupted.id } })).status, "CANCELLED");
  } finally {
    await db.project.deleteMany({ where: { members: { some: { userId: owner } } } });
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  }
});
