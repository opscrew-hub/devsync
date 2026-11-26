/**
 * DevSync's actions as the host calls them (docs/platform.md, Actions): the start-up rules the host
 * checks, the kinds and callers of the table, the guidance in the descriptions, the size budget,
 * and each caller kind: a member with their role, an agent, and a managed run that only reads.
 */
import { MCP_TOOL_INPUTS, type Role } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_RULES, actions, MCP_INSTRUCTIONS } from "./actions";
import { agent } from "./db";
import { listRuns, rejectRun, requestRun, SETUP_STEP } from "./domain/runs";
import { createTask, getTask, updateTask } from "./domain/tasks";
import type { Caller, DevSyncAction, Member, ProjectContext, ProjectRef } from "./host";
import { hostAgent, setClock } from "./test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "./testing";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * The most characters the actions' list (names as the host lists them, descriptions and input
 * JSON schemas, as JSON) may take: the size P3 reached, rounded up to the next 1,000. Raise it only
 * with a reason: every agent reads the whole list.
 */
const ACTIONS_BUDGET = 10_000;

const KINDS = {
  get_project_state: "read",
  list_tasks: "read",
  get_task: "read",
  get_pending_signals: "read",
  acknowledge_signal: "write",
  claim_task: "write",
  renew_task_claim: "write",
  release_task: "write",
  publish_signal: "write",
  create_task: "write",
  update_task: "write",
  report_progress: "write",
  report_blocker: "write",
  request_review: "write",
  submit_review: "write",
  request_run: "start",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: each action types its own input, as the contract's list.
function named(name: keyof typeof KINDS): DevSyncAction<any> {
  const found = actions.find((a) => a.name === name);
  if (!found) throw new Error(`DevSync has no action ${name}.`);
  return found;
}

/** The actions' list as the host's `/mcp` lists it, as JSON. */
function listed(): string {
  return JSON.stringify(
    actions.map((a) => ({
      name: `devsync_${a.name}`,
      description: a.description,
      inputSchema: z.toJSONSchema(a.input),
    })),
  );
}

/** A project with DevSync on, a member of each role, and two of the host's agents. */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const roles: Role[] = ["owner", "admin", "approver", "developer"];
  const members: Member[] = roles.map((role) => ({
    userId: crypto.randomUUID(),
    name: `The ${role}`,
    role,
  }));
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: members },
    projects: [project],
  });
  const owner = members[0] as Member;
  const memberCtx = (member: Member = owner): ProjectContext => ({ project, member });
  const asMember = (member: Member = owner): Caller => ({ kind: "member", ...member });
  // Connected to DevSync's own endpoint once, so DevSync has its row.
  const codex = await hostAgent(host, project, { name: "Codex", kind: "CODEX" });
  // Registered on the host and never seen by DevSync: it calls through the host's `/mcp` only.
  const claudeId = crypto.randomUUID();
  host.directory.agents.push({
    agentId: claudeId,
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    name: "Claude",
    kind: "claude",
    modules: ["devsync"],
    tokenHash: "0".repeat(64),
    revokedAt: null,
  });
  const asCodex: Caller = { kind: "agent", agentId: codex.id, name: "Codex" };
  const asClaude: Caller = { kind: "agent", agentId: claudeId, name: "Claude" };
  const asRun: Caller = { kind: "run", runRef: crypto.randomUUID(), module: "devsync" };

  /** Calls an action as the host does: its input parsed with the action's schema, over `/mcp`. */
  const call = (name: keyof typeof KINDS, caller: Caller, input: object = {}, on = project) => {
    const action = named(name);
    return action.run({ project: on, caller, via: "mcp", host }, action.input.parse(input));
  };
  /** An action's result, which must not be a refusal. */
  const result = async (name: keyof typeof KINDS, caller: Caller, input: object = {}) => {
    const answer = await call(name, caller, input);
    expect(answer.result, JSON.stringify(answer.result)).not.toHaveProperty("refused");
    // biome-ignore lint/suspicious/noExplicitAny: a test reads the domain's answers as JSON.
    return answer.result as any;
  };
  /** An action's refusal: its code and message. */
  const refused = async (name: keyof typeof KINDS, caller: Caller, input: object = {}) => {
    const answer = await call(name, caller, input);
    expect(answer.confirm).toBeUndefined();
    return (answer.result as { refused: { code: string; message: string } }).refused;
  };
  /** A Ready task a member made. */
  const readyTask = async (title = "Ship checkout") => {
    const created = await createTask(host, memberCtx(), {
      title,
      description: "Card payments",
      acceptanceCriteria: "Pays",
    });
    return updateTask(host, memberCtx(), created.id, { version: created.version, status: "READY" });
  };
  return {
    host,
    project,
    members,
    memberCtx,
    asMember,
    codex,
    claudeId,
    asCodex,
    asClaude,
    asRun,
    call,
    result,
    refused,
    readyTask,
  };
}

describe("DevSync's actions", () => {
  it("declare each MCP tool once, as the host's start-up rules want", () => {
    expect(actions.map((a) => a.name).sort()).toEqual(Object.keys(MCP_TOOL_INPUTS).sort());
    expect(new Set(actions.map((a) => a.name)).size).toBe(actions.length);
    for (const action of actions) {
      expect(action.name).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
      expect(`devsync_${action.name}`.length).toBeLessThanOrEqual(64);
      expect(action.input).toBeInstanceOf(z.ZodObject);
      expect(Object.keys((action.input as z.ZodObject).shape)).not.toContain("projectId");
      expect(action.input).toBe(MCP_TOOL_INPUTS[action.name as keyof typeof MCP_TOOL_INPUTS]);
      expect(action.description.length).toBeGreaterThan(0);
      expect(action.description.length).toBeLessThanOrEqual(1000);
      // DevSync's own checks are `can()`'s, inside `run`: no host permission fits them.
      expect(action.permission).toBeUndefined();
    }
  });

  it("have the kinds of docs/platform.md's table", () => {
    expect(Object.fromEntries(actions.map((a) => [a.name, a.kind]))).toEqual(KINDS);
  });

  it("give the rules an agent needs in the descriptions they concern, and the same instructions", () => {
    const concerns: Record<keyof typeof ACTION_RULES, (keyof typeof KINDS)[]> = {
      start: ["get_project_state", "get_pending_signals"],
      claim: ["claim_task"],
      renew: ["claim_task", "renew_task_claim"],
      blocker: ["report_progress", "report_blocker"],
      review: ["request_review"],
      recall: ["claim_task"],
      remember: ["request_review"],
    };
    for (const [rule, names] of Object.entries(concerns)) {
      const text = ACTION_RULES[rule as keyof typeof ACTION_RULES];
      for (const name of names) expect(named(name).description).toContain(text);
      expect(MCP_INSTRUCTIONS).toContain(text);
    }
    expect(ACTION_RULES.renew).toContain("15 minutes");
    expect(ACTION_RULES.recall).toContain("memory tools");
    expect(ACTION_RULES.remember).toContain("memory tools");
  });

  it("stay within their size budget", () => {
    expect(listed().length).toBeLessThanOrEqual(ACTIONS_BUDGET);
  });
});

describe("a member calling an action", () => {
  it("reads the project, its tasks and a task with its pull request", async () => {
    const s = await setup();
    const task = await s.readyTask();
    await updateTask(s.host, s.memberCtx(), task.id, {
      version: task.version,
      assigneeUserId: s.members[3]?.userId,
    });

    const state = await s.result("get_project_state", s.asMember());
    expect(state.project).toEqual({
      id: s.project.projectId,
      fullName: "acme/app",
      readOnly: false,
    });
    expect(state.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);

    const developer = s.members[3] as Member;
    const mine = await s.result("list_tasks", s.asMember(developer), { assignee: "me" });
    expect(mine.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    const ownersOwn = await s.result("list_tasks", s.asMember(), { assignee: "me" });
    expect(ownersOwn.tasks).toEqual([]);

    const read = await s.result("get_task", s.asMember(), { taskId: task.id });
    expect(read).toEqual({ task: await getTask(s.host, s.memberCtx(), task.id), latestRun: null });
    expect(read.task.pullRequest).toBeNull();

    // Its latest run, for every caller.
    const first = await requestRun(s.host, s.memberCtx(), task.id);
    await rejectRun(s.host, s.memberCtx(), first.id);
    // A minute on, so the second run is the latest by its time, not by its random id.
    setClock(s.host, Date.parse(FAKE_NOW) + 60_000);
    const second = await requestRun(s.host, s.memberCtx(developer), task.id);
    for (const caller of [s.asMember(), s.asCodex, s.asRun]) {
      const { latestRun } = await s.result("get_task", caller, { taskId: task.id });
      expect(latestRun).toMatchObject({ id: second.id, status: "REQUESTED" });
    }
    expect((await s.refused("get_task", s.asMember(), { taskId: crypto.randomUUID() })).code).toBe(
      "not-found",
    );
  });

  it("proposes a managed run of a Ready task, creating nothing: a start", async () => {
    const s = await setup();
    const task = await s.readyTask();
    const developer = s.members[3] as Member;
    expect(await s.call("request_run", s.asMember(developer), { taskId: task.id })).toEqual({
      result: { taskId: task.id, title: "Ship checkout", revision: 1 },
      confirm: { label: "Ask for a managed run" },
    });
    expect((await listRuns(s.host, s.memberCtx(), task.id)).runs).toEqual([]);

    // Refused as asking for one is, with the same words, and then nothing to confirm.
    await requestRun(s.host, s.memberCtx(), task.id);
    expect(await s.refused("request_run", s.asMember(), { taskId: task.id })).toEqual({
      code: "conflict",
      message:
        "This task already has a run that hasn't ended. Wait for it to finish, or cancel it while it waits for approval.",
    });
    const other = await s.readyTask("Another");
    s.host.github.repository = { workflow: false, secrets: [] };
    expect(await s.refused("request_run", s.asMember(), { taskId: other.id })).toEqual({
      code: "conflict",
      message: SETUP_STEP.workflow,
    });
    expect((await listRuns(s.host, s.memberCtx(), other.id)).runs).toEqual([]);
  });

  it("creates and edits tasks as themselves, with their role", async () => {
    const s = await setup();
    const approver = s.members[2] as Member;
    const input = {
      requestId: crypto.randomUUID(),
      title: "From the chat",
      description: "",
      acceptanceCriteria: "Works",
    };
    const created = await s.result("create_task", s.asMember(approver), input);
    // Its confirm pressed twice, or a member's own client retrying: the same task.
    expect(await s.result("create_task", s.asMember(approver), input)).toEqual(created);
    expect((await s.result("list_tasks", s.asMember())).tasks).toHaveLength(1);
    expect((await getTask(s.host, s.memberCtx(), created.id)).creator).toEqual({
      kind: "member",
      userId: approver.userId,
      name: "The approver",
    });
    const edited = await s.result("update_task", s.asMember(), {
      taskId: created.id,
      version: created.version,
      status: "READY",
    });
    expect(edited).toMatchObject({ id: created.id, status: "READY" });
  });

  it("is refused an agents-only action, and a write to a read-only project, as the result", async () => {
    const s = await setup();
    const task = await s.readyTask();
    expect(
      await s.refused("claim_task", s.asMember(), {
        taskId: task.id,
        claimId: crypto.randomUUID(),
      }),
    ).toEqual({
      code: "forbidden",
      message:
        "Only a coding agent claims a task. Register one from the project's Agents button, then ask it to.",
    });
    for (const name of [
      "get_pending_signals",
      "acknowledge_signal",
      "renew_task_claim",
      "release_task",
      "publish_signal",
      "report_progress",
      "report_blocker",
      "request_review",
      "submit_review",
    ] as const) {
      const answer = await s.call(name, s.asMember(), sampleInput(name, task.id));
      const { refused } = answer.result as { refused: { code: string; message: string } };
      expect(refused.code).toBe("forbidden");
      expect(refused.message).toMatch(/^Only a coding agent /);
    }

    const frozen = { ...s.project, readOnly: true };
    const answer = await s.call(
      "update_task",
      s.asMember(),
      { taskId: task.id, version: 1 },
      frozen,
    );
    expect((answer.result as { refused: { message: string } }).refused.message).toContain(
      "read-only",
    );
  });
});

describe("an agent calling an action", () => {
  it("acts as itself: its first call through the host's /mcp makes DevSync's row of it", async () => {
    const s = await setup();
    const task = await s.readyTask();
    const claim = { taskId: task.id, claimId: crypto.randomUUID() };

    const lease = await s.result("claim_task", s.asClaude, claim);
    expect(lease).toMatchObject({ id: task.id, status: "CLAIMED", claimId: claim.claimId });
    const [row] = await testDb.db.select().from(agent).where(eq(agent.id, s.claudeId));
    expect(row).toMatchObject({ name: "Claude", kind: "CLAUDE", projectId: s.project.projectId });
    const read = await s.result("get_task", s.asClaude, { taskId: task.id });
    expect(read.task.claim).toMatchObject({ agentId: s.claudeId, agentName: "Claude" });

    // Another agent's claim of it is DevSync's refusal, answered as the result.
    expect(
      await s.refused("claim_task", s.asCodex, { taskId: task.id, claimId: crypto.randomUUID() }),
    ).toEqual({
      code: "conflict",
      message:
        "This task isn't available to claim: it isn't Ready, or another agent holds it. Pick another Ready task, or try again after its claim expires.",
    });
    const progress = {
      ...claim,
      revision: task.revision,
      requestId: crypto.randomUUID(),
      message: "Halfway.",
    };
    expect(await s.result("report_progress", s.asClaude, progress)).toMatchObject({
      taskId: task.id,
      kind: "implementation.progress",
    });
    expect(await s.result("get_pending_signals", s.asCodex)).toEqual([]);
  });

  it("is refused `me`, a members-only start, and when the host no longer lists it", async () => {
    const s = await setup();
    const task = await s.readyTask();
    expect((await s.refused("list_tasks", s.asCodex, { assignee: "me" })).code).toBe("invalid");
    expect(await s.refused("request_run", s.asCodex, { taskId: task.id })).toEqual({
      code: "forbidden",
      message:
        "Only a member can ask for a managed run. Ask one to do it from the task's runs section in DevSync's tab.",
    });
    s.host.directory.agents = s.host.directory.agents.filter((a) => a.agentId !== s.claudeId);
    expect((await s.refused("get_project_state", s.asClaude)).code).toBe("unauthenticated");
  });
});

describe("a managed run calling an action", () => {
  it("reads the project and its tasks", async () => {
    const s = await setup();
    const task = await s.readyTask();
    const state = await s.result("get_project_state", s.asRun);
    expect(state.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect((await s.result("list_tasks", s.asRun, { status: "READY" })).tasks).toHaveLength(1);
    expect((await s.result("get_task", s.asRun, { taskId: task.id })).task.id).toBe(task.id);
    expect((await s.refused("list_tasks", s.asRun, { assignee: "me" })).code).toBe("invalid");
  });

  it("is refused every write, an agent's inbox and a start, changing nothing", async () => {
    const s = await setup();
    const task = await s.readyTask();
    const message =
      "A managed run can only read the project's state and its tasks; what it changes reaches the task through its draft pull request.";
    for (const name of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      if (["get_project_state", "list_tasks", "get_task"].includes(name)) continue;
      expect(await s.refused(name, s.asRun, sampleInput(name, task.id))).toEqual({
        code: "forbidden",
        message,
      });
    }
    expect(await getTask(s.host, s.memberCtx(), task.id)).toMatchObject({
      status: "READY",
      version: task.version,
    });
  });
});

describe("a fault in an action", () => {
  it("throws, so the host reports it as failed, and a retry answers what was saved", async () => {
    const s = await setup();
    s.host.enqueue = async () => {
      throw new Error("The queue is unavailable.");
    };
    const input = {
      requestId: crypto.randomUUID(),
      title: "Agent task",
      description: "",
      acceptanceCriteria: "",
    };
    await expect(s.call("create_task", s.asCodex, input)).rejects.toThrow("unavailable");
    s.host.enqueue = async () => {};
    expect((await s.result("create_task", s.asCodex, input)).title).toBe("Agent task");
  });
});

/** A valid input for each action, about `taskId`. */
function sampleInput(name: keyof typeof KINDS, taskId: string): object {
  const id = () => crypto.randomUUID();
  const activity = { taskId, claimId: id(), revision: 1, requestId: id(), message: "Done." };
  const inputs: Record<keyof typeof KINDS, object> = {
    get_project_state: {},
    list_tasks: {},
    get_task: { taskId },
    get_pending_signals: {},
    acknowledge_signal: { id: id() },
    claim_task: { taskId, claimId: id() },
    renew_task_claim: { taskId, claimId: id() },
    release_task: { taskId, claimId: id() },
    publish_signal: {
      recipientId: id(),
      kind: "review.requested",
      payload: { message: "Please review." },
      idempotencyKey: id(),
    },
    create_task: { requestId: id(), title: "T", description: "", acceptanceCriteria: "" },
    update_task: { taskId, version: 1, title: "Changed" },
    report_progress: activity,
    report_blocker: activity,
    request_review: activity,
    submit_review: {
      taskId,
      reviewRequestId: id(),
      revision: 1,
      requestId: id(),
      decision: "APPROVED",
      message: "Fine.",
    },
    request_run: { taskId },
  };
  return inputs[name];
}
