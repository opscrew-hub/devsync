import { existsSync, readFileSync } from "node:fs";
import { type Finding as FindingSchema, MemberList, type Role, TaskList } from "@devsync/schemas";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { hashToken } from "./domain/agents";
import type { GithubJob as GithubJobSchema } from "./domain/pull-requests";
import { createTask } from "./domain/tasks";
import type {
  AdoptedAgent,
  AgentRef,
  ContextBlock,
  ContextEntry,
  DevSyncAgents,
  DevSyncEvent,
  DevSyncGithub,
  DevSyncHost,
  EventData,
  Finding,
  GithubFailure,
  GithubJob,
  Member,
  ProjectContext,
  ProjectEnv,
  ProjectRef,
} from "./host";
import { serverModule } from "./module";
import {
  createTestDb,
  FAKE_NOW,
  type FakeHostAgent,
  fakeHost,
  fakeToken,
  type TestDb,
} from "./testing";

// The host's contract (control plane, specs/002-modules/contracts/modules.md), copied: DevSync
// never imports the host, so these prove that what the host gives fits what DevSync takes, and
// that what DevSync exports fits what the host takes.
namespace Contract {
  // biome-ignore lint/suspicious/noExplicitAny: the host's own schema type, which a module never reads.
  export type ModuleDb = PgDatabase<PgQueryResultHKT, any>;
  export interface Member {
    userId: string;
    name: string;
    role: "owner" | "admin" | "approver" | "developer";
  }
  export interface ProjectRef {
    workspaceId: string;
    projectId: string;
    fullName: string;
    readOnly: boolean;
  }
  export interface ModuleHost {
    db: ModuleDb;
    clock: { now(): Date };
    log: { error(message: string): void };
    audit(
      tx: ModuleDb,
      actor: { userId: string } | "host",
      entry: {
        workspaceId: string;
        projectId: string;
        action: string;
        detail: Record<string, string | number | boolean | null>;
      },
    ): Promise<void>;
    members(workspaceId: string): Promise<Member[]>;
    project(projectId: string): Promise<ProjectRef | null>;
    enqueue(
      queue: string,
      payload: Record<string, unknown>,
      options?: { singleton?: { key: string; seconds: number } },
    ): Promise<void>;
    github: ModuleGithub;
    finding(projectId: string, fingerprint: string): Promise<ModuleFinding | null>;
    ai: {
      allowRun(input: { projectId: string; runRef: string; workflow: string }): Promise<{
        request: string;
        origin: string;
      } | null>;
    };
    emit: (
      tx: ModuleDb,
      event: { workspaceId: string; projectId: string; type: string; data: EventData },
    ) => Promise<void>;
    agents: ModuleAgents;
    context: (
      caller: { projectId: string } & ({ userId: string } | { agentId: string }),
      input: { subject: string },
    ) => Promise<ContextBlock>;
    redact: (text: string) => string;
  }
  export type EventData = Record<string, string | number | boolean | null>;
  export interface AgentRef {
    agentId: string;
    projectId: string;
    workspaceId: string;
    name: string;
    kind: "claude" | "codex" | "other";
    modules: string[];
  }
  export interface ModuleAgents {
    verify: (token: string) => Promise<AgentRef | null>;
    list: (projectId: string) => Promise<AgentRef[]>;
    adopt: (
      tx: ModuleDb,
      agents: readonly {
        agentId: string;
        workspaceId: string;
        projectId: string;
        name: string;
        kind: "claude" | "codex" | "other";
        tokenHash: string;
        expiresAt: Date;
        revokedAt: Date | null;
        lastSeenAt: Date | null;
        registeredBy: string | null;
        createdAt: Date;
      }[],
    ) => Promise<number>;
  }
  export interface ContextItem {
    kind: "instruction" | "fact" | "event";
    text: string;
    source: string;
    authorUserId?: string;
    at?: string;
  }
  export interface ContextBlock {
    instructions: ContextEntry[];
    facts: ContextEntry[];
  }
  export interface ContextEntry {
    source: string;
    kind: ContextItem["kind"];
    author: string;
    trust: "trusted" | "untrusted";
    text: string;
  }
  export interface ModuleFinding {
    fingerprint: string;
    ruleId: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    file: string | null;
    line: number | null;
    description: string | null;
    remediation: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    dismissal: { reason: "false-positive" | "accepted-risk" } | null;
  }
  export type GithubFact =
    | {
        kind: "push";
        deliveryId: string;
        ref: string;
        before: string;
        after: string;
        defaultBranch: boolean;
      }
    | {
        kind: "pull_request";
        deliveryId: string;
        action: string;
        number: number;
        title: string;
        state: "open" | "closed";
        merged: boolean;
        url: string;
        headRef: string;
        headSha: string;
        updatedAt: string;
      }
    | { kind: "workflow_run"; deliveryId: string; githubRunId: number; conclusion: string | null };
  export interface ModuleGithubJob {
    workspaceId: string;
    projectId: string;
    fact: GithubFact;
  }
  export type GithubFailure =
    | "not-found"
    | "unavailable"
    | "workflow-missing"
    | "workflow-disabled"
    | "forbidden";
  export interface ModuleGithub {
    setup(
      projectId: string,
      workflow: string,
    ): Promise<
      { ok: true; workflow: boolean; secrets: string[] } | { ok: false; failure: GithubFailure }
    >;
    dispatch(
      projectId: string,
      workflow: string,
      inputs: Record<string, string>,
    ): Promise<
      { ok: true; githubRunId: number; url: string } | { ok: false; failure: GithubFailure }
    >;
    artifact(
      projectId: string,
      githubRunId: number,
      name: string,
    ): Promise<
      { ok: true; files: Map<string, Uint8Array> | null } | { ok: false; failure: GithubFailure }
    >;
    deleteArtifact(
      projectId: string,
      githubRunId: number,
      name: string,
    ): Promise<{ ok: true } | { ok: false; failure: GithubFailure }>;
  }
  export interface ModuleJob {
    handler(payload: unknown, host: ModuleHost): Promise<void>;
    cron?: string;
    retryLimit: number;
    retryBackoff?: boolean;
    retryDelay?: number;
    retryDelayMax?: number;
  }
  export interface ServerModule {
    migrations: { folder: string; schema: string };
    // biome-ignore lint/suspicious/noExplicitAny: the contract's own type.
    projectRoutes?(host: ModuleHost): Hono<any>;
    // biome-ignore lint/suspicious/noExplicitAny: the contract's own type.
    workspaceRoutes?(host: ModuleHost): Hono<any>;
    // biome-ignore lint/suspicious/noExplicitAny: the contract's own type.
    publicRoutes?(host: ModuleHost): Hono<any>;
    jobs?: Record<string, ModuleJob>;
    github?: boolean;
    workflows?: readonly string[];
    removeProject(tx: ModuleDb, projectId: string): Promise<void>;
    removeWorkspace(tx: ModuleDb, workspaceId: string): Promise<void>;
    removeMember(tx: ModuleDb, workspaceId: string, userId: string): Promise<void>;
    exportProject?: (tx: ModuleDb, projectId: string) => Promise<unknown>;
  }
}

/** Compiles only when `From` is assignable to `To`. */
function assignable<To>(_value: To): void {}

/** A value of type `T`, for the typecheck only. */
function some<T>(): T {
  return null as unknown as T;
}

/** The function `F` taking nothing as its parameters: what no strictly checked `F` takes. */
type TakingLess<F> = F extends (...args: never[]) => infer R
  ? (first: never, ...rest: never[]) => R
  : never;

describe("the contract's types (checked by the typecheck)", () => {
  it("a host's ModuleHost is a DevSyncHost, and serverModule is a ServerModule", () => {
    assignable<DevSyncHost>(some<Contract.ModuleHost>());
    assignable<Contract.ServerModule>(serverModule);
    assignable<Member>(some<Contract.Member>());
    expect(true).toBe(true);
  });

  it("checks the parameters of the host's functions strictly, so a copy widening one fails", () => {
    // Arrow properties, as the contract has them: a method's parameters are checked both ways, so
    // a copy that widened one (`redact(text: string | null)`) would still take the host's. A
    // strict member refuses a function that takes less than it says.
    type Agents = DevSyncHost["agents"];
    type Ai = DevSyncHost["ai"];
    type Github = DevSyncGithub;
    // @ts-expect-error: takes less
    assignable<DevSyncHost["emit"]>(some<TakingLess<DevSyncHost["emit"]>>());
    // @ts-expect-error: takes less
    assignable<DevSyncHost["context"]>(some<TakingLess<DevSyncHost["context"]>>());
    // @ts-expect-error: takes less
    assignable<DevSyncHost["redact"]>(some<TakingLess<DevSyncHost["redact"]>>());
    // @ts-expect-error: takes less
    assignable<Agents["verify"]>(some<TakingLess<Agents["verify"]>>());
    // @ts-expect-error: takes less
    assignable<Agents["list"]>(some<TakingLess<Agents["list"]>>());
    // @ts-expect-error: takes less
    assignable<Agents["adopt"]>(some<TakingLess<Agents["adopt"]>>());
    // @ts-expect-error: takes less
    assignable<Ai["allowRun"]>(some<TakingLess<Ai["allowRun"]>>());
    // @ts-expect-error: takes less
    assignable<Github["setup"]>(some<TakingLess<Github["setup"]>>());
    // @ts-expect-error: takes less
    assignable<Github["dispatch"]>(some<TakingLess<Github["dispatch"]>>());
    // @ts-expect-error: takes less
    assignable<Github["artifact"]>(some<TakingLess<Github["artifact"]>>());
    // @ts-expect-error: takes less
    assignable<Github["deleteArtifact"]>(some<TakingLess<Github["deleteArtifact"]>>());
    // The check itself: a method's widened parameter still takes the host's; an arrow's doesn't.
    type Widened = { redact(text: string | null): string };
    assignable<Widened>(some<Contract.ModuleHost>());
    // @ts-expect-error: the host's `redact` takes a string only
    assignable<{ redact: (text: string | null) => string }>(some<Contract.ModuleHost>());
    expect(true).toBe(true);
  });

  it("DevSync's copies of the host's GitHub types are the contract's, both ways", () => {
    assignable<DevSyncGithub>(some<Contract.ModuleGithub>());
    assignable<Contract.ModuleGithub>(some<DevSyncGithub>());
    assignable<GithubFailure>(some<Contract.GithubFailure>());
    assignable<Contract.GithubFailure>(some<GithubFailure>());
    assignable<GithubJob>(some<Contract.ModuleGithubJob>());
    assignable<Contract.ModuleGithubJob>(some<GithubJob>());
    // Every fact the host sends is one the devsync.github queue's schema can take.
    assignable<z.input<typeof GithubJobSchema>>(some<Contract.ModuleGithubJob>());
    assignable<GithubJob>(some<z.output<typeof GithubJobSchema>>());
    expect(true).toBe(true);
  });

  it("DevSync's copies of the module platform's types are the contract's, both ways", () => {
    assignable<EventData>(some<Contract.EventData>());
    assignable<Contract.EventData>(some<EventData>());
    // Every event DevSync emits is one the host's `emit` takes.
    assignable<Parameters<Contract.ModuleHost["emit"]>[1]>(some<DevSyncEvent>());
    assignable<AgentRef>(some<Contract.AgentRef>());
    assignable<Contract.AgentRef>(some<AgentRef>());
    assignable<DevSyncAgents>(some<Contract.ModuleAgents>());
    assignable<Contract.ModuleAgents>(some<DevSyncAgents>());
    type ContractAdopted = Parameters<Contract.ModuleAgents["adopt"]>[1][number];
    assignable<AdoptedAgent>(some<ContractAdopted>());
    assignable<ContractAdopted>(some<AdoptedAgent>());
    assignable<ContextBlock>(some<Contract.ContextBlock>());
    assignable<Contract.ContextBlock>(some<ContextBlock>());
    assignable<ContextEntry>(some<Contract.ContextEntry>());
    assignable<Contract.ContextEntry>(some<ContextEntry>());
    assignable<DevSyncHost["ai"]>(some<Contract.ModuleHost["ai"]>());
    assignable<Contract.ModuleHost["ai"]>(some<DevSyncHost["ai"]>());
    assignable<DevSyncHost["context"]>(some<Contract.ModuleHost["context"]>());
    assignable<Contract.ModuleHost["context"]>(some<DevSyncHost["context"]>());
    expect(true).toBe(true);
  });

  it("DevSync's copy of the host's finding is the contract's, both ways, and its schema takes it", () => {
    assignable<Finding>(some<Contract.ModuleFinding>());
    assignable<Contract.ModuleFinding>(some<Finding>());
    // Every finding the host gives is one the Finding schema can take, and what it parses is one.
    assignable<z.input<typeof FindingSchema>>(some<Contract.ModuleFinding>());
    assignable<Finding>(some<z.output<typeof FindingSchema>>());
    expect(true).toBe(true);
  });
});

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

const root = new URL("../../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).opscrewModule;

describe("the opscrewModule manifest", () => {
  it("names DevSync, its icon, its workspace page, its finding action and its two entries", () => {
    expect(manifest).toEqual({
      id: "devsync",
      name: "DevSync",
      summary: expect.any(String),
      icon: "kanban",
      workspacePage: true,
      findingAction: { label: "Fix with DevSync" },
      server: "packages/server/src/module.ts",
      web: "packages/web/src/module.tsx",
    });
    // The host's rule for the button's label: 1 to 40 characters of plain text.
    expect(manifest.findingAction.label).toMatch(/^[^<>&]{1,40}$/);
    expect(manifest.id).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
    expect(manifest.summary.length).toBeGreaterThan(0);
    expect(manifest.summary.length).toBeLessThanOrEqual(200);
    expect(existsSync(new URL(manifest.server, root))).toBe(true);
    expect(existsSync(new URL(manifest.web, root))).toBe(true);
  });

  it("matches serverModule: the migrations' schema and the queues are named for the id", () => {
    expect(serverModule.migrations.schema).toBe(manifest.id);
    expect(existsSync(serverModule.migrations.folder)).toBe(true);
    for (const queue of Object.keys(serverModule.jobs)) {
      expect(queue.startsWith(`${manifest.id}.`)).toBe(true);
    }
    expect(serverModule.github).toBe(true);
    expect(Object.keys(serverModule.jobs)).toContain(`${manifest.id}.github`);
    // The host's rule for `workflows`: bare `*.yml` or `*.yaml` names, and `github` with them.
    expect(serverModule.workflows).toEqual(["devsync.yml"]);
    for (const file of serverModule.workflows) expect(file).toMatch(/^[\w.-]+\.ya?ml$/);
  });
});

describe("serverModule", () => {
  it("has its jobs, routes and removal hooks", () => {
    expect(Object.keys(serverModule.jobs).sort()).toEqual([
      "devsync.github",
      "devsync.outbox",
      "devsync.runs",
    ]);
    expect(serverModule.jobs["devsync.outbox"].cron).toBe("* * * * *");
    expect(serverModule.jobs["devsync.runs"].cron).toBe("*/10 * * * *");
    for (const job of Object.values(serverModule.jobs)) {
      expect(typeof job.handler).toBe("function");
      expect(job.retryLimit).toBeGreaterThan(0);
    }
    for (const hook of [
      serverModule.removeProject,
      serverModule.removeWorkspace,
      serverModule.removeMember,
      serverModule.exportProject,
    ]) {
      expect(typeof hook).toBe("function");
    }
    const host = fakeHost(testDb.db);
    expect(serverModule.workspaceRoutes(host)).toBeInstanceOf(Hono);
    expect(serverModule.publicRoutes(host)).toBeInstanceOf(Hono);
  });

  it("answers a project's tasks and members behind a guard that sets c.var.module", async () => {
    const workspaceId = crypto.randomUUID();
    const project: ProjectRef = {
      workspaceId,
      projectId: crypto.randomUUID(),
      fullName: "acme/app",
      readOnly: false,
    };
    const roles: Role[] = ["owner", "developer"];
    const members: Member[] = roles.map((role) => ({
      userId: crypto.randomUUID(),
      name: `The ${role}`,
      role,
    }));
    const host = fakeHost(testDb.db, { members: { [workspaceId]: members }, projects: [project] });
    const ctx: ProjectContext = { project, member: members[0] as Member };
    await createTask(host, ctx, {
      title: "Add the sign-up form",
      description: "",
      acceptanceCriteria: "",
    });

    const mount = "/api/w/:ws/projects/:pid/m/devsync";
    const app = new Hono<ProjectEnv>();
    app.use(`${mount}/*`, async (c, next) => {
      c.set("module", ctx);
      await next();
    });
    app.route(mount, serverModule.projectRoutes(host));
    const base = `/api/w/${workspaceId}/projects/${project.projectId}/m/devsync`;

    const tasks = await app.request(`${base}/tasks`);
    expect(tasks.status).toBe(200);
    const list = TaskList.parse(await tasks.json());
    expect(list.tasks.map((t) => t.title)).toEqual(["Add the sign-up form"]);

    const answered = await app.request(`${base}/members`);
    expect(answered.status).toBe(200);
    expect(MemberList.parse(await answered.json()).members).toEqual(members);
  });
});

describe("fakeHost's module platform members", () => {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const agentOf = (token: string, fields: Partial<FakeHostAgent> = {}): FakeHostAgent => ({
    agentId: crypto.randomUUID(),
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    name: "Codex",
    kind: "codex",
    modules: ["devsync"],
    tokenHash: hashToken(token),
    ...fields,
  });

  it("verifies an agent by its token's hash while it may reach DevSync, and lists the project's", async () => {
    const token = fakeToken();
    const elsewhere = fakeToken();
    const expired = fakeToken();
    const live = agentOf(token);
    const host = fakeHost(testDb.db, {
      projects: [project],
      agents: [
        live,
        agentOf(elsewhere, { modules: ["other"] }),
        agentOf(expired, { expiresAt: new Date(FAKE_NOW) }),
      ],
    });
    const { tokenHash: _hash, ...ref } = live;
    expect(await host.agents.verify(token)).toEqual(ref);
    expect(await host.agents.verify(fakeToken())).toBeNull();
    expect(await host.agents.verify(elsewhere)).toBeNull();
    expect(await host.agents.verify(expired)).toBeNull();
    expect((await host.agents.list(project.projectId)).map((a) => a.name)).toEqual([
      "Codex",
      "Codex",
    ]);
    host.directory.projects = [];
    expect(await host.agents.verify(token)).toBeNull();
  });

  it("adopts DevSync's agents once, keeping their tokens working, and refuses what the host refuses", async () => {
    const host = fakeHost(testDb.db, { projects: [project] });
    const token = fakeToken();
    const row = {
      agentId: crypto.randomUUID(),
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      name: "Claude",
      kind: "claude" as const,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.parse(FAKE_NOW) + 60_000),
      revokedAt: null,
      lastSeenAt: null,
      registeredBy: null,
      createdAt: new Date(FAKE_NOW),
    };
    await testDb.db.transaction(async (tx) => {
      expect(await host.agents.adopt(tx, [row])).toBe(1);
      expect(await host.agents.adopt(tx, [row])).toBe(1);
      expect(host.agents.adopted.map((call) => call.tx)).toEqual([tx, tx]);
    });
    expect(host.agents.adopted.map((call) => call.agents)).toEqual([[row], [row]]);
    expect(await host.agents.list(project.projectId)).toHaveLength(1);
    expect(await host.agents.verify(token)).toMatchObject({
      agentId: row.agentId,
      modules: ["devsync"],
    });
    await expect(host.agents.adopt(host.db, [{ ...row, tokenHash: "not a hash" }])).rejects.toThrow(
      "64 hex",
    );
    await expect(
      host.agents.adopt(host.db, [{ ...row, workspaceId: crypto.randomUUID() }]),
    ).rejects.toThrow("workspace");
    expect(host.agents.adopted).toHaveLength(2);
  });

  it("records each event with its transaction, and answers the context a test sets", async () => {
    const host = fakeHost(testDb.db, { projects: [project] });
    const event = {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      type: "devsync.task.done" as const,
      data: { taskId: crypto.randomUUID() },
    };
    await testDb.db.transaction((tx) => host.emit(tx, event));
    expect(host.emitted).toEqual([{ tx: expect.anything(), event }]);
    expect(host.emitted[0]?.tx).not.toBe(host.db);

    const caller = { projectId: project.projectId, userId: crypto.randomUUID() };
    expect(await host.context(caller, { subject: "Ship checkout" })).toEqual({
      instructions: [],
      facts: [],
    });
    const entry = {
      source: "memory 1",
      kind: "fact" as const,
      author: "Owner",
      trust: "trusted" as const,
      text: "Checkout runs on the card provider's sandbox.",
    };
    host.contextBlock = { instructions: [], facts: [entry] };
    expect(await host.context(caller, { subject: "Ship checkout" })).toEqual({
      instructions: [],
      facts: [entry],
    });
    expect(host.contextAsked).toEqual([
      { caller, subject: "Ship checkout" },
      { caller, subject: "Ship checkout" },
    ]);
  });

  it("redacts each fakeToken() value, and leaves other text as it is", () => {
    const host = fakeHost(testDb.db);
    const token = fakeToken();
    expect(host.redact(`Bearer ${token}, again ${token}.`)).toBe(
      "Bearer [redacted], again [redacted].",
    );
    const hash = hashToken(token);
    const id = crypto.randomUUID();
    expect(host.redact(`Task ${id}, hash ${hash}.`)).toBe(`Task ${id}, hash ${hash}.`);
  });

  it("allows a run of DevSync's workflow for a writable project with DevSync on, and records each ask", async () => {
    const frozen = { ...project, projectId: crypto.randomUUID(), readOnly: true };
    const host = fakeHost(testDb.db, { projects: [project, frozen] });
    const ask = (projectId: string, workflow = "devsync.yml") =>
      host.ai.allowRun({ projectId, runRef: "run 1", workflow });
    expect(await ask(project.projectId)).toEqual(host.ai.run);
    expect(await ask(frozen.projectId)).toBeNull();
    expect(await ask(crypto.randomUUID())).toBeNull();
    expect(await ask(project.projectId, "other.yml")).toBeNull();
    expect(host.ai.asked).toHaveLength(4);
    expect(host.ai.asked[0]).toEqual({
      projectId: project.projectId,
      runRef: "run 1",
      workflow: "devsync.yml",
    });
  });
});
