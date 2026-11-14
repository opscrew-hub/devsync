import {
  AgentList,
  AgentMessageReceipt,
  AgentWithToken,
  Comment,
  ErrorAnswer,
  MemberList,
  PullRequestList,
  type Role,
  Run,
  RunList,
  RunSetup,
  Task,
  TaskDetail,
  TaskList,
  WorkspaceTaskList,
} from "@devsync/schemas";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pullRequest } from "../db";
import { registerAgent } from "../domain/agents";
import { createTask, updateTask } from "../domain/tasks";
import type {
  Member,
  ProjectContext,
  ProjectEnv,
  ProjectRef,
  WorkspaceContext,
  WorkspaceEnv,
} from "../host";
import { createTestDb, FAKE_NOW, type FakeHost, fakeHost, type TestDb } from "../testing";
import { projectRoutes, workspaceRoutes } from "./index";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

const ROLES: Role[] = ["owner", "admin", "approver", "developer"];
const PROJECT_MOUNT = "/api/w/:workspace/projects/:project/m/devsync";
const WORKSPACE_MOUNT = "/api/w/:workspace/m/devsync";
const INTERNAL =
  "Something went wrong on DevSync's side. Try again; if it keeps failing, tell OpsCrew's support.";

interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
}

type Send = (method: string, path: string, body?: unknown) => Promise<Answer>;

type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Sends a request through `fetch`: `body` as JSON, or as it is when it's a string. */
async function send(fetch: Fetch, method: string, url: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** The project's routes mounted as the host mounts them, its guard setting `ctx` first. */
function projectClient(host: FakeHost, ctx: ProjectContext): Send {
  const app = new Hono<ProjectEnv>();
  app.use(`${PROJECT_MOUNT}/*`, async (c, next) => {
    c.set("module", ctx);
    await next();
  });
  app.route(PROJECT_MOUNT, projectRoutes(host));
  const base = `/api/w/${ctx.project.workspaceId}/projects/${ctx.project.projectId}/m/devsync`;
  return (method, path, body) =>
    send((url, init) => app.request(url, init), method, `${base}${path}`, body);
}

/** The workspace's routes mounted as the host mounts them. */
function workspaceClient(host: FakeHost, ctx: WorkspaceContext): Send {
  const app = new Hono<WorkspaceEnv>();
  app.use(`${WORKSPACE_MOUNT}/*`, async (c, next) => {
    c.set("module", ctx);
    await next();
  });
  app.route(WORKSPACE_MOUNT, workspaceRoutes(host));
  const base = `/api/w/${ctx.workspaceId}/m/devsync`;
  return (method, path, body) =>
    send((url, init) => app.request(url, init), method, `${base}${path}`, body);
}

/** A workspace with a member of each role and two projects with DevSync on. */
function setup() {
  const workspaceId = crypto.randomUUID();
  const project: ProjectRef = {
    workspaceId,
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const members: Member[] = ROLES.map((role) => ({
    userId: crypto.randomUUID(),
    name: `The ${role}`,
    role,
  }));
  const host = fakeHost(testDb.db, {
    members: { [workspaceId]: members },
    projects: [project, other],
  });
  const member = (role: Role): Member => {
    const found = members.find((m) => m.role === role);
    if (!found) throw new Error(`no ${role}`);
    return found;
  };
  const ctx = (role: Role, on: ProjectRef = project): ProjectContext => ({
    project: on,
    member: member(role),
  });
  const as = (role: Role, on: ProjectRef = project) => projectClient(host, ctx(role, on));
  return { host, workspaceId, project, other, members, member, ctx, as };
}

function refusal(answer: Answer, status: number, code: string) {
  expect(answer.status).toBe(status);
  const { error } = ErrorAnswer.parse(answer.body);
  expect(error.code).toBe(code);
  return error;
}

function addPullRequest(on: ProjectRef, number: number, updatedAt: Date) {
  return testDb.db.insert(pullRequest).values({
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    number,
    title: `Change ${number}`,
    state: "open",
    url: `https://github.com/${on.fullName}/pull/${number}`,
    headRef: `change-${number}`,
    headSha: "0".repeat(40),
    sourceUpdatedAt: updatedAt,
  });
}

const newTask = { title: "Ship the export", description: "CSV", acceptanceCriteria: "Downloads" };

describe("project routes", () => {
  it("create, list, read, edit, comment on and link a project's tasks", async () => {
    const { project, as, member } = setup();
    const developer = as("developer");
    const created = await developer("POST", "/tasks", newTask);
    expect(created.status).toBe(201);
    const task = Task.parse(created.body);
    expect(task).toMatchObject({
      projectId: project.projectId,
      title: "Ship the export",
      status: "BACKLOG",
      revision: 1,
      version: 1,
      assigneeUserId: null,
      claim: null,
      createdAt: FAKE_NOW,
    });
    expect(created.headers.get("cache-control")).toBe("no-store");

    const listed = await developer("GET", "/tasks");
    expect(listed.status).toBe(200);
    expect(TaskList.parse(listed.body).tasks).toEqual([task]);
    expect((await developer("GET", "/tasks?status=READY")).body).toEqual({ tasks: [] });

    const { userId } = member("developer");
    const edited = await developer("PATCH", `/tasks/${task.id}`, {
      version: task.version,
      status: "READY",
      assigneeUserId: userId,
      acceptanceCriteria: "Downloads, with headers",
    });
    expect(edited.status).toBe(200);
    expect(Task.parse(edited.body)).toMatchObject({
      status: "READY",
      revision: 2,
      version: 2,
      assigneeUserId: userId,
    });
    expect(TaskList.parse((await developer("GET", "/tasks?assignee=me")).body).tasks).toHaveLength(
      1,
    );
    expect((await as("owner")("GET", "/tasks?assignee=me")).body).toEqual({ tasks: [] });
    expect((await developer("GET", `/tasks?assignee=none`)).body).toEqual({ tasks: [] });
    expect(
      TaskList.parse((await developer("GET", `/tasks?status=READY&assignee=${userId}`)).body).tasks,
    ).toHaveLength(1);

    const commented = await developer("POST", `/tasks/${task.id}/comments`, { body: "On it." });
    expect(commented.status).toBe(201);
    expect(Comment.parse(commented.body)).toMatchObject({
      author: { kind: "member", userId, name: "The developer" },
      body: "On it.",
    });

    await addPullRequest(project, 7, new Date(FAKE_NOW));
    const linked = await developer("PUT", `/tasks/${task.id}/pull-request`, { number: 7 });
    expect(linked.status).toBe(200);
    expect(Task.parse(linked.body).pullRequestNumber).toBe(7);
    refusal(
      await developer("PUT", `/tasks/${task.id}/pull-request`, { number: 8 }),
      404,
      "not-found",
    );

    const read = await developer("GET", `/tasks/${task.id}`);
    expect(read.status).toBe(200);
    const detail = TaskDetail.parse(read.body);
    expect(detail).toMatchObject({
      id: task.id,
      description: "CSV",
      acceptanceCriteria: "Downloads, with headers",
      creator: { kind: "member", userId, name: "The developer" },
      pullRequest: { number: 7, state: "open" },
    });
    expect(detail.revisions.map((r) => r.number)).toEqual([2, 1]);
    expect(detail.comments.map((c) => c.body)).toEqual(["On it."]);
    // One time for both: the fake clock is fixed.
    expect(detail.timeline.map((e) => e.kind).sort()).toEqual([
      "requirements.changed",
      "task.created",
    ]);

    const unlinked = await developer("PUT", `/tasks/${task.id}/pull-request`, { number: null });
    expect(Task.parse(unlinked.body).pullRequestNumber).toBeNull();
  });

  it("list the project's 50 most recently updated pull requests", async () => {
    const { project, other, as } = setup();
    const start = Date.parse(FAKE_NOW);
    for (let number = 1; number <= 52; number++) {
      await addPullRequest(project, number, new Date(start + number * 1000));
    }
    await addPullRequest(other, 99, new Date(start + 99_000));
    const answer = await as("approver")("GET", "/pull-requests");
    expect(answer.status).toBe(200);
    const { pullRequests } = PullRequestList.parse(answer.body);
    expect(pullRequests.map((p) => p.number)).toEqual(Array.from({ length: 50 }, (_, i) => 52 - i));
    expect(pullRequests[0]).toEqual({
      number: 52,
      title: "Change 52",
      state: "open",
      url: "https://github.com/acme/app/pull/52",
      updatedAt: new Date(start + 52_000).toISOString(),
    });
  });

  it("answer the workspace's members", async () => {
    const { members, as } = setup();
    const answer = await as("developer")("GET", "/members");
    expect(answer.status).toBe(200);
    expect(MemberList.parse(answer.body)).toEqual({ members });
  });

  it("register, list, rotate and revoke agents, and message one once by its key", async () => {
    const { as } = setup();
    const registered = await as("owner")("POST", "/agents", { name: "Codex", kind: "CODEX" });
    expect(registered.status).toBe(201);
    expect(registered.headers.get("cache-control")).toBe("no-store");
    const { agent, token } = AgentWithToken.parse(registered.body);
    expect(agent).toMatchObject({ name: "Codex", kind: "CODEX", status: "Offline" });

    const listed = await as("developer")("GET", "/agents");
    expect(AgentList.parse(listed.body).agents.map((a) => a.id)).toEqual([agent.id]);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const rotated = await as("admin")("POST", `/agents/${agent.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(AgentWithToken.parse(rotated.body).token).not.toBe(token);

    const message = {
      kind: "clarification.answered",
      message: "Use the staging database.",
      idempotencyKey: crypto.randomUUID(),
    };
    const sent = await as("developer")("POST", `/agents/${agent.id}/messages`, message);
    expect(sent.status).toBe(201);
    const receipt = AgentMessageReceipt.parse(sent.body);
    const again = await as("developer")("POST", `/agents/${agent.id}/messages`, message);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(receipt);
    refusal(
      await as("developer")("POST", `/agents/${agent.id}/messages`, { ...message, message: "No" }),
      409,
      "conflict",
    );

    const revoked = await as("owner")("DELETE", `/agents/${agent.id}`);
    expect(revoked.status).toBe(204);
    expect(revoked.body).toBeUndefined();
    expect(AgentList.parse((await as("owner")("GET", "/agents")).body).agents[0]?.status).toBe(
      "Revoked",
    );
    expect((await as("owner")("DELETE", `/agents/${agent.id}`)).status).toBe(204);
  });

  describe.each(ROLES)("a member who is %s", (role) => {
    const manages = role === "owner" || role === "admin";

    it(`reads everything, changes tasks and messages agents, and ${manages ? "manages" : "can't manage"} agents`, async () => {
      const { host, project, ctx, as } = setup();
      const task = await createTask(host, ctx("owner"), newTask);
      const { agent } = await registerAgent(host, ctx("owner"), { name: "Codex", kind: "CODEX" });
      await addPullRequest(project, 1, new Date(FAKE_NOW));
      const member = as(role);

      for (const path of ["/tasks", `/tasks/${task.id}`, "/pull-requests", "/members", "/agents"]) {
        expect((await member("GET", path)).status, path).toBe(200);
      }

      expect((await member("POST", "/tasks", newTask)).status).toBe(201);
      expect(
        (await member("PATCH", `/tasks/${task.id}`, { version: 1, title: "New" })).status,
      ).toBe(200);
      expect((await member("POST", `/tasks/${task.id}/comments`, { body: "Hi" })).status).toBe(201);
      expect((await member("PUT", `/tasks/${task.id}/pull-request`, { number: 1 })).status).toBe(
        200,
      );
      const message = {
        kind: "system.warning",
        message: "Heads up.",
        idempotencyKey: crypto.randomUUID(),
      };
      expect((await member("POST", `/agents/${agent.id}/messages`, message)).status).toBe(201);

      const register = await member("POST", "/agents", { name: "Claude", kind: "CLAUDE" });
      const rotate = await member("POST", `/agents/${agent.id}/rotate`);
      // A refused member is refused before their body is read.
      const invalid = await member("POST", "/agents", { name: "" });
      const revoke = await member("DELETE", `/agents/${agent.id}`);
      if (manages) {
        expect(register.status).toBe(201);
        expect(rotate.status).toBe(200);
        refusal(invalid, 422, "invalid");
        expect(revoke.status).toBe(204);
      } else {
        for (const answer of [register, rotate, invalid, revoke]) {
          expect(refusal(answer, 403, "forbidden").message).toBe(
            "Only an Owner or Admin can register, rotate or revoke agents. Ask one of them.",
          );
        }
        const { agents } = AgentList.parse((await member("GET", "/agents")).body);
        expect(agents.map((a) => [a.id, a.status])).toEqual([[agent.id, "Offline"]]);
      }
    });
  });

  it("don't find another project's tasks and agents, or ids that aren't UUIDs", async () => {
    const { host, other, ctx, as } = setup();
    const theirs = await createTask(host, ctx("owner", other), newTask);
    const { agent } = await registerAgent(host, ctx("owner", other), {
      name: "Theirs",
      kind: "CLAUDE",
    });
    await addPullRequest(other, 3, new Date(FAKE_NOW));
    const owner = as("owner");
    const mine = Task.parse((await owner("POST", "/tasks", newTask)).body);

    expect(TaskList.parse((await owner("GET", "/tasks")).body).tasks.map((t) => t.id)).toEqual([
      mine.id,
    ]);
    expect((await owner("GET", "/pull-requests")).body).toEqual({ pullRequests: [] });
    expect((await owner("GET", "/agents")).body).toEqual({ agents: [] });
    refusal(await owner("GET", `/tasks/${theirs.id}`), 404, "not-found");
    refusal(
      await owner("PATCH", `/tasks/${theirs.id}`, { version: 1, title: "x" }),
      404,
      "not-found",
    );
    refusal(await owner("POST", `/tasks/${theirs.id}/comments`, { body: "x" }), 404, "not-found");
    refusal(
      await owner("PUT", `/tasks/${theirs.id}/pull-request`, { number: 3 }),
      404,
      "not-found",
    );
    refusal(await owner("PUT", `/tasks/${mine.id}/pull-request`, { number: 3 }), 404, "not-found");
    refusal(await owner("POST", `/agents/${agent.id}/rotate`), 404, "not-found");
    refusal(await owner("DELETE", `/agents/${agent.id}`), 404, "not-found");
    const message = { kind: "system.warning", message: "x", idempotencyKey: crypto.randomUUID() };
    refusal(await owner("POST", `/agents/${agent.id}/messages`, message), 404, "not-found");
    refusal(await owner("GET", "/tasks/not-a-uuid"), 404, "not-found");
    refusal(await owner("PATCH", "/tasks/not-a-uuid", { version: 1 }), 404, "not-found");
    refusal(await owner("DELETE", "/agents/not-a-uuid"), 404, "not-found");

    const { agents } = AgentList.parse((await as("owner", other)("GET", "/agents")).body);
    expect(agents.map((a) => a.status)).toEqual(["Offline"]);
    const unchanged = TaskDetail.parse(
      (await as("owner", other)("GET", `/tasks/${theirs.id}`)).body,
    );
    expect(unchanged).toMatchObject({ title: theirs.title, version: 1, comments: [] });
    expect(unchanged.pullRequest).toBeNull();
  });

  it("refuse a bad body or query with its fields, and a stale version", async () => {
    const { as } = setup();
    const owner = as("owner");
    const blank = refusal(await owner("POST", "/tasks", { ...newTask, title: "" }), 422, "invalid");
    expect(blank).toEqual({
      code: "invalid",
      message: "Check this field and try again: title.",
      fields: ["title"],
    });
    expect(
      refusal(await owner("POST", "/tasks", { ...newTask, priority: 1 }), 422, "invalid").fields,
    ).toEqual(["priority"]);
    expect(refusal(await owner("POST", "/tasks", "{"), 422, "invalid").fields).toEqual(["body"]);
    expect(refusal(await owner("POST", "/tasks"), 422, "invalid").fields).toEqual(["body"]);
    expect(
      refusal(await owner("POST", "/agents", { name: "x".repeat(81), kind: "GPT" }), 422, "invalid")
        .fields,
    ).toEqual(["name", "kind"]);
    expect(refusal(await owner("GET", "/tasks?status=SOMEDAY"), 422, "invalid").fields).toEqual([
      "status",
    ]);
    expect(refusal(await owner("GET", "/tasks?assignee=him"), 422, "invalid").fields).toEqual([
      "assignee",
    ]);
    expect(refusal(await owner("GET", "/tasks?sort=new"), 422, "invalid").fields).toEqual(["sort"]);

    const task = Task.parse((await owner("POST", "/tasks", newTask)).body);
    expect(
      refusal(await owner("PATCH", `/tasks/${task.id}`, { title: "No version" }), 422, "invalid")
        .fields,
    ).toEqual(["version"]);
    expect(
      refusal(
        await owner("POST", `/tasks/${task.id}/comments`, { body: "x".repeat(4001) }),
        422,
        "invalid",
      ).fields,
    ).toEqual(["body"]);
    expect((await owner("PATCH", `/tasks/${task.id}`, { version: 1, title: "First" })).status).toBe(
      200,
    );
    const stale = refusal(
      await owner("PATCH", `/tasks/${task.id}`, { version: 1, title: "Second" }),
      409,
      "conflict",
    );
    expect(stale.message).toBe("This task changed. Reload it and try again.");
    expect(TaskDetail.parse((await owner("GET", `/tasks/${task.id}`)).body).title).toBe("First");
  });

  it("answer an unexpected failure as internal and log it without the body or a token", async () => {
    const { host, as } = setup();
    host.members = async () => {
      throw new Error("The directory is unavailable.");
    };
    const members = await as("owner")("GET", "/members");
    expect(members.status).toBe(500);
    expect(members.body).toEqual({ error: { code: "internal", message: INTERNAL } });
    expect(ErrorAnswer.safeParse(members.body).success).toBe(true);
    expect(members.headers.get("cache-control")).toBe("no-store");
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toContain("GET");
    expect(host.errors[0]).toContain("/members");
    expect(host.errors[0]).toContain("The directory is unavailable.");

    host.audit = async () => {
      throw new Error("The audit log is unavailable.");
    };
    const registered = await as("owner")("POST", "/agents", { name: "Secret name", kind: "CODEX" });
    expect(registered.status).toBe(500);
    expect(registered.body).toEqual({ error: { code: "internal", message: INTERNAL } });
    expect(host.errors).toHaveLength(2);
    expect(host.errors[1]).toContain("The audit log is unavailable.");
    expect(host.errors[1]).not.toContain("Secret name");
    expect((await as("owner")("GET", "/agents")).body).toEqual({ agents: [] });
  });
});

describe("project run routes", () => {
  /** A Ready task of the project, made by the owner. */
  async function readyTask(s: ReturnType<typeof setup>, on?: ProjectRef) {
    const created = await createTask(s.host, s.ctx("owner", on), newTask);
    return updateTask(s.host, s.ctx("owner", on), created.id, {
      version: created.version,
      status: "READY",
    });
  }

  it("answer the setup, ask for a run, approve it and list the task's runs", async () => {
    const s = setup();
    const ready = await readyTask(s);
    const developer = s.as("developer");

    const setupAnswer = await developer("GET", "/runs/setup");
    expect(setupAnswer.status).toBe(200);
    expect(RunSetup.parse(setupAnswer.body)).toEqual({ workflow: true, secret: true, missing: [] });
    expect(setupAnswer.headers.get("cache-control")).toBe("no-store");

    const asked = await developer("POST", `/tasks/${ready.id}/runs`);
    expect(asked.status).toBe(201);
    const run = Run.parse(asked.body);
    expect(run).toMatchObject({ taskId: ready.id, revision: 1, status: "REQUESTED" });

    const approved = await s.as("approver")("POST", `/runs/${run.id}/approve`);
    expect(approved.status).toBe(200);
    expect(Run.parse(approved.body)).toMatchObject({
      id: run.id,
      status: "QUEUED",
      decidedBy: { kind: "member", name: "The approver" },
    });

    const listed = await developer("GET", `/tasks/${ready.id}/runs`);
    expect(listed.status).toBe(200);
    expect(RunList.parse(listed.body).runs.map((r) => [r.id, r.status])).toEqual([
      [run.id, "QUEUED"],
    ]);
  });

  it("answer 409 with the setup's words while the repository lacks the workflow or the key", async () => {
    const s = setup();
    const ready = await readyTask(s);
    s.host.github.repository = { workflow: false, secrets: [] };
    const missing = RunSetup.parse((await s.as("owner")("GET", "/runs/setup")).body).missing;
    expect(missing).toEqual([
      "Add .github/workflows/devsync.yml from the runs section to the repository's default branch.",
      "Add the ANTHROPIC_API_KEY Actions secret to the repository or its organization.",
    ]);
    const refused = refusal(
      await s.as("developer")("POST", `/tasks/${ready.id}/runs`),
      409,
      "conflict",
    );
    expect(refused.message).toBe(missing.join(" "));
    expect((await s.as("developer")("GET", `/tasks/${ready.id}/runs`)).body).toEqual({ runs: [] });

    s.host.github.fail.setup = "not-found";
    refusal(await s.as("owner")("GET", "/runs/setup"), 404, "not-found");
  });

  describe.each(ROLES)("a member who is %s", (role) => {
    const decides = role !== "developer";

    it(`asks for runs, cancels their own, and ${decides ? "decides" : "can't decide"} runs`, async () => {
      const s = setup();
      const member = s.as(role);
      const one = Run.parse(
        (await s.as("developer")("POST", `/tasks/${(await readyTask(s)).id}/runs`)).body,
      );
      const two = Run.parse(
        (await s.as("developer")("POST", `/tasks/${(await readyTask(s)).id}/runs`)).body,
      );

      const approve = await member("POST", `/runs/${one.id}/approve`);
      const reject = await member("POST", `/runs/${two.id}/reject`);
      if (decides) {
        expect(Run.parse(approve.body).status).toBe("QUEUED");
        expect(Run.parse(reject.body).status).toBe("REJECTED");
      } else {
        for (const answer of [approve, reject]) {
          expect(refusal(answer, 403, "forbidden").message).toBe(
            "Only an Owner, Admin or Approver can approve or reject a run. Ask one of them.",
          );
        }
      }

      const ready = await readyTask(s);
      const own = await member("POST", `/tasks/${ready.id}/runs`);
      expect(own.status).toBe(201);
      const cancelled = await member("POST", `/runs/${Run.parse(own.body).id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(Run.parse(cancelled.body).status).toBe("CANCELLED");

      const theirs = Run.parse(
        (await s.as(role === "owner" ? "admin" : "owner")("POST", `/tasks/${ready.id}/runs`)).body,
      );
      const cancel = await member("POST", `/runs/${theirs.id}/cancel`);
      if (decides) expect(cancel.status).toBe(200);
      else refusal(cancel, 403, "forbidden");
    });
  });

  it("don't find another project's tasks or runs", async () => {
    const s = setup();
    const theirs = await readyTask(s, s.other);
    const theirRun = Run.parse(
      (await s.as("developer", s.other)("POST", `/tasks/${theirs.id}/runs`)).body,
    );
    const owner = s.as("owner");
    refusal(await owner("GET", `/tasks/${theirs.id}/runs`), 404, "not-found");
    refusal(await owner("POST", `/tasks/${theirs.id}/runs`), 404, "not-found");
    for (const action of ["approve", "reject", "cancel"]) {
      refusal(await owner("POST", `/runs/${theirRun.id}/${action}`), 404, "not-found");
      refusal(await owner("POST", `/runs/not-a-uuid/${action}`), 404, "not-found");
    }
    const unchanged = await s.as("owner", s.other)("GET", `/tasks/${theirs.id}/runs`);
    expect(RunList.parse(unchanged.body).runs.map((r) => r.status)).toEqual(["REQUESTED"]);
  });
});

describe("workspace routes", () => {
  /** Two projects with DevSync on in the workspace's context, and one with it off. */
  async function workspace() {
    const base = setup();
    const { host, workspaceId, project, other, ctx } = base;
    const off: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/off" };
    const open = await createTask(host, ctx("owner"), { ...newTask, title: "Open" });
    const cancelledDraft = await createTask(host, ctx("owner"), { ...newTask, title: "Cancelled" });
    const cancelled = await updateTask(host, ctx("owner"), cancelledDraft.id, {
      version: cancelledDraft.version,
      status: "CANCELLED",
    });
    const draft = await createTask(host, ctx("owner", other), { ...newTask, title: "Assigned" });
    const assigned = await updateTask(host, ctx("owner", other), draft.id, {
      version: draft.version,
      assigneeUserId: base.member("developer").userId,
    });
    await createTask(host, ctx("owner", off), { ...newTask, title: "Off" });
    const as = (role: Role) =>
      workspaceClient(host, { workspaceId, member: base.member(role), projects: [project, other] });
    return { ...base, off, open, cancelled, assigned, as };
  }

  it("list the open tasks of the projects with DevSync on, by project, status and assignee", async () => {
    const { project, other, off, open, cancelled, assigned, as } = await workspace();
    const all = WorkspaceTaskList.parse((await as("developer")("GET", "/tasks")).body).tasks;
    expect(all.map((t) => [t.title, t.projectName]).sort()).toEqual([
      ["Assigned", "acme/other"],
      ["Open", "acme/app"],
    ]);
    const byProject = await as("developer")("GET", `/tasks?project=${project.projectId}`);
    expect(WorkspaceTaskList.parse(byProject.body).tasks.map((t) => t.id)).toEqual([open.id]);
    const byStatus = await as("developer")("GET", "/tasks?status=CANCELLED");
    expect(WorkspaceTaskList.parse(byStatus.body).tasks.map((t) => t.id)).toEqual([cancelled.id]);
    const mine = await as("developer")("GET", "/tasks?assignee=me");
    expect(WorkspaceTaskList.parse(mine.body).tasks).toEqual([
      { ...assigned, projectName: "acme/other" },
    ]);
    expect((await as("owner")("GET", "/tasks?assignee=me")).body).toEqual({ tasks: [] });
    expect(
      WorkspaceTaskList.parse(
        (await as("owner")("GET", `/tasks?project=${other.projectId}&assignee=none`)).body,
      ).tasks,
    ).toEqual([]);
    expect(mine.headers.get("cache-control")).toBe("no-store");

    refusal(await as("owner")("GET", `/tasks?project=${off.projectId}`), 404, "not-found");
    expect(refusal(await as("owner")("GET", "/tasks?project=acme"), 422, "invalid").fields).toEqual(
      ["project"],
    );
    expect(refusal(await as("owner")("GET", "/tasks?page=2"), 422, "invalid").fields).toEqual([
      "page",
    ]);
  });

  it("answer the workspace's members to every role", async () => {
    const { members, as } = await workspace();
    for (const role of ROLES) {
      const answer = await as(role)("GET", "/members");
      expect(answer.status).toBe(200);
      expect(MemberList.parse(answer.body)).toEqual({ members });
      expect((await as(role)("GET", "/tasks")).status).toBe(200);
    }
  });

  it("answer an unexpected failure as internal", async () => {
    const { host, as } = await workspace();
    host.members = async () => {
      throw new Error("The directory is unavailable.");
    };
    const answer = await as("owner")("GET", "/members");
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: { code: "internal", message: INTERNAL } });
    expect(host.errors).toEqual([expect.stringContaining("The directory is unavailable.")]);
  });
});
