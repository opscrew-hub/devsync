import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent } from "../db";
import type { Member, ProjectContext, ProjectRef } from "../host";
import { devsyncAgent, hostAgent } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { reportProgress } from "./activity";
import { claimTask } from "./claims";
import { exportProject } from "./export";
import { applyGithubFact } from "./pull-requests";
import { answerQuestion, askAgentQuestion } from "./questions";
import { requestRun } from "./runs";
import { commentOnTask, createTask, linkPullRequest, updateTask } from "./tasks";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * Two projects of one workspace, each with an agent and a task with two revisions, a comment, a
 * pull request and a run.
 */
async function setup() {
  const workspaceId = randomUUID();
  const project = (fullName: string): ProjectRef => ({
    workspaceId,
    projectId: randomUUID(),
    fullName,
    readOnly: false,
  });
  const shop = project("acme/shop");
  const api = project("acme/api");
  const owner: Member = { userId: randomUUID(), name: "Owner", role: "owner" };
  const host = fakeHost(testDb.db, { members: { [workspaceId]: [owner] }, projects: [shop, api] });
  // Each reading a second after the last, so the rows' order is the order they were made in.
  let now = Date.parse(FAKE_NOW);
  host.clock = {
    now: () => {
      now += 1000;
      return new Date(now);
    },
  };
  const fill = async (on: ProjectRef, title: string) => {
    const ctx: ProjectContext = { project: on, member: owner };
    // DevSync's own, not yet moved: its row still has its token's hash.
    const registered = await devsyncAgent(host, on, { name: `${title} agent`, kind: "CODEX" });
    const first = await createTask(host, ctx, {
      title: `${title}: first step`,
      description: "",
      acceptanceCriteria: "",
    });
    const created = await createTask(host, ctx, {
      title,
      description: "",
      acceptanceCriteria: "",
      owns: ["src/"],
      labels: ["ui"],
      branch: "feature/x",
    });
    const ready = await updateTask(host, ctx, created.id, {
      version: created.version,
      description: "Revised",
      status: "READY",
    });
    // An agent reports its usage on the first step.
    const builder = await hostAgent(host, on, { name: `${title} builder`, kind: "CLAUDE" });
    await updateTask(host, ctx, first.id, { version: first.version, status: "READY" });
    const claim = { taskId: first.id, claimId: crypto.randomUUID() };
    await claimTask(host, builder.actor, claim);
    await reportProgress(host, builder.actor, {
      ...claim,
      revision: 1,
      requestId: crypto.randomUUID(),
      message: "Halfway.",
      usage: { inputTokens: 10, costUsd: 0.01 },
    });
    await commentOnTask(host, ctx, created.id, { body: `About ${title}` });
    const question = await askAgentQuestion(host, builder.actor, {
      taskId: created.id,
      requestId: crypto.randomUUID(),
      text: `Which ${title}?`,
    });
    await answerQuestion(host, ctx, question.id, { answer: "The first." });
    await applyGithubFact(host, {
      workspaceId,
      projectId: on.projectId,
      fact: {
        kind: "pull_request",
        deliveryId: randomUUID(),
        action: "opened",
        number: 4,
        title: `${title} pull request`,
        state: "open",
        merged: false,
        url: `https://github.com/${on.fullName}/pull/4`,
        headRef: "feature",
        headSha: "b".repeat(40),
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const linked = await linkPullRequest(host, ctx, created.id, { number: 4 });
    const asked = await requestRun(host, ctx, ready.id);
    // It waits for its first step from now on: a run is asked for only while it waits for none.
    await updateTask(host, ctx, created.id, { version: linked.version, dependsOn: [first.id] });
    return { taskId: created.id, firstId: first.id, agentId: registered.id, runId: asked.id };
  };
  return {
    shop,
    api,
    shopRows: await fill(shop, "Ship checkout"),
    apiRows: await fill(api, "Add API keys"),
  };
}

/** The project's export, in a read-only transaction as the host runs it. */
function exported(projectId: string) {
  return testDb.db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return exportProject(tx, projectId);
  });
}

describe("exportProject", () => {
  it("holds the project's tasks with their revisions and comments, runs, pull requests and timeline", async () => {
    const { shop, shopRows } = await setup();
    const data = await exported(shop.projectId);

    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0]).toMatchObject({ id: shopRows.firstId, dependsOn: [] });
    expect(data.tasks[1]).toMatchObject({
      id: shopRows.taskId,
      projectId: shop.projectId,
      title: "Ship checkout",
      description: "Revised",
      status: "READY",
      pullRequestNumber: 4,
      owns: ["src/"],
      dependsOn: [shopRows.firstId],
      labels: ["ui"],
      branch: "feature/x",
    });
    expect(data.tasks[1]?.revisions.map((r) => [r.number, r.description])).toEqual([
      [1, ""],
      [2, "Revised"],
    ]);
    expect(data.tasks[1]?.comments.map((c) => c.body)).toEqual(["About Ship checkout"]);
    expect(data.tasks[1]?.questions.map((q) => [q.text, q.answer])).toEqual([
      ["Which Ship checkout?", "The first."],
    ]);
    expect(data.tasks[0]?.questions).toEqual([]);
    expect(data.runs.map((r) => [r.id, r.taskId, r.status])).toEqual([
      [shopRows.runId, shopRows.taskId, "REQUESTED"],
    ]);
    expect(data.pullRequests.map((p) => [p.number, p.title])).toEqual([
      [4, "Ship checkout pull request"],
    ]);
    expect(data.timeline.map((e) => e.kind)).toEqual([
      "task.created",
      "task.created",
      "requirements.changed",
      "task.updated",
      "implementation.progress",
      "question.asked",
      "question.answered",
      "run.requested",
    ]);
    expect(data.timeline.find((e) => e.kind === "implementation.progress")?.usage).toEqual({
      inputTokens: 10,
      costUsd: 0.01,
    });
    // The agents are the host's to export: the timeline names them by id.
    expect(Object.keys(data)).toEqual(["tasks", "runs", "pullRequests", "timeline"]);
  });

  it("holds nothing of another project's, and no token hash", async () => {
    const { shop, api, apiRows } = await setup();
    const json = JSON.stringify(await exported(shop.projectId));
    for (const id of [api.projectId, apiRows.taskId, apiRows.agentId, apiRows.runId]) {
      expect(json).not.toContain(id);
    }
    expect(json).not.toContain("Add API keys");
    const hashes = await testDb.db
      .select({ tokenHash: agent.tokenHash })
      .from(agent)
      .where(and(eq(agent.workspaceId, shop.workspaceId), isNotNull(agent.tokenHash)));
    // DevSync's own two; the host's agents' rows have none.
    expect(hashes).toHaveLength(2);
    for (const { tokenHash } of hashes) expect(json).not.toContain(tokenHash);
    expect(json).not.toContain("tokenHash");
  });

  it("holds empty lists for a project DevSync has no rows of", async () => {
    expect(await exported(randomUUID())).toEqual({
      tasks: [],
      runs: [],
      pullRequests: [],
      timeline: [],
    });
  });
});
