import { existsSync, readFileSync } from "node:fs";
import { MemberList, type Role, TaskList } from "@devsync/schemas";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask } from "./domain/tasks";
import type { DevSyncHost, Member, ProjectContext, ProjectEnv, ProjectRef } from "./host";
import { serverModule } from "./module";
import { createTestDb, fakeHost, type TestDb } from "./testing";

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
    removeProject(tx: ModuleDb, projectId: string): Promise<void>;
    removeWorkspace(tx: ModuleDb, workspaceId: string): Promise<void>;
    removeMember(tx: ModuleDb, workspaceId: string, userId: string): Promise<void>;
  }
}

/** Compiles only when `From` is assignable to `To`. */
function assignable<To>(_value: To): void {}

describe("the contract's types (checked by the typecheck)", () => {
  it("a host's ModuleHost is a DevSyncHost, and serverModule is a ServerModule", () => {
    const host = null as unknown as Contract.ModuleHost;
    assignable<DevSyncHost>(host);
    assignable<Contract.ServerModule>(serverModule);
    const member = null as unknown as Contract.Member;
    assignable<Member>(member);
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
  it("names DevSync, its icon, its workspace page and its two entries", () => {
    expect(manifest).toEqual({
      id: "devsync",
      name: "DevSync",
      summary: expect.any(String),
      icon: "kanban",
      workspacePage: true,
      server: "packages/server/src/module.ts",
      web: "packages/web/src/module.tsx",
    });
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
  });
});

describe("serverModule", () => {
  it("has its jobs, routes and removal hooks", () => {
    expect(Object.keys(serverModule.jobs).sort()).toEqual(["devsync.github", "devsync.outbox"]);
    expect(serverModule.jobs["devsync.outbox"].cron).toBe("* * * * *");
    for (const job of Object.values(serverModule.jobs)) {
      expect(typeof job.handler).toBe("function");
      expect(job.retryLimit).toBeGreaterThan(0);
    }
    for (const hook of [
      serverModule.removeProject,
      serverModule.removeWorkspace,
      serverModule.removeMember,
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
