/**
 * `@devsync/server/testing`: an in-memory PostgreSQL (PGlite) with DevSync's migrations applied as
 * the host applies them, a fake host (with a scriptable GitHub, agents, context, redactor and AI),
 * and fresh token-shaped values, so no test commits one.
 */
import { randomBytes } from "node:crypto";
import { WORKFLOW_FILE } from "@devsync/schemas";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrations } from "./db";
import { hashToken } from "./domain/agents";
import type {
  AdoptedAgent,
  AgentRef,
  AuditActor,
  AuditEntry,
  ContextBlock,
  DevSyncAgents,
  DevSyncDb,
  DevSyncEvent,
  DevSyncGithub,
  DevSyncHost,
  Finding,
  GithubFailure,
  Member,
  ProjectRef,
  QueueName,
} from "./host";

export interface TestDb {
  db: DevSyncDb;
  /** Applies the migrations again, as the host does on every start (nothing new is applied). */
  migrate(): Promise<void>;
  /** Frees the database. */
  close(): Promise<void>;
}

/** A fresh in-memory database with DevSync's migrations applied. Nothing touches the disk. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle({ client });
  const apply = () =>
    migrate(db, {
      migrationsFolder: migrations.folder,
      migrationsSchema: migrations.schema,
      migrationsTable: "__drizzle_migrations",
    });
  await apply();
  return { db, migrate: apply, close: () => client.close() };
}

/** The fake host's time unless the test gives one. */
export const FAKE_NOW = "2026-01-01T00:00:00.000Z";

export interface FakeHostOptions {
  /** Each workspace's members, by workspace id. */
  members?: Record<string, Member[]>;
  /** The projects with DevSync on: what `project(id)` finds. */
  projects?: ProjectRef[];
  /** Each project's open security findings, by project id: what `finding()` finds. */
  findings?: Record<string, Finding[]>;
  /** The host's agents: what `agents.verify()` and `agents.list()` find. */
  agents?: FakeHostAgent[];
  /** The clock's fixed time, ISO 8601. */
  now?: string;
}

/**
 * One of the host's agents in the fake: its `AgentRef`, the SHA-256 (hex) of its token
 * (`hashToken` from domain/agents.ts), and, if any, when its token expires and when it was revoked.
 */
export interface FakeHostAgent extends AgentRef {
  tokenHash: string;
  expiresAt?: Date;
  revokedAt?: Date | null;
}

/** The fake host's agents, over `directory.agents`, and a record of what `adopt` moved. */
export interface FakeAgents extends DevSyncAgents {
  /** Each call to `adopt`: the transaction it was given and its rows. */
  adopted: { tx: DevSyncDb; agents: AdoptedAgent[] }[];
}

/** The fake host's AI: `allowRun` answers `run` for a writable project with DevSync on. */
export interface FakeAi {
  allowRun: DevSyncHost["ai"]["allowRun"];
  /** What `allowRun` answers. */
  run: { request: string; origin: string };
  /** Every input `allowRun` was given. */
  asked: Parameters<DevSyncHost["ai"]["allowRun"]>[0][];
}

/** What the fake redactor (and the host's) puts in place of a credential-shaped value. */
const REDACTED = "[redacted]";

/** A `fakeToken()`-shaped value: 43 characters of base64url, standing alone. */
const TOKEN_SHAPED = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/** One of the fake GitHub's artifacts: a run's, by name, with its files. */
export interface FakeArtifact {
  githubRunId: number;
  name: string;
  files: Map<string, Uint8Array>;
}

/**
 * The fake host's GitHub: scripted answers, and a record of what DevSync asked. Each call answers
 * `not-found` for a project `project()` doesn't find or a workflow other than DevSync's, as the
 * host does, then the failure `fail` scripts for it, if any.
 */
export interface FakeGithub extends DevSyncGithub {
  /** What `setup` finds: the workflow on the default branch, and the secrets' names. */
  repository: { workflow: boolean; secrets: string[] };
  /** The failure each method answers, until a test clears it. */
  fail: Partial<Record<keyof DevSyncGithub, GithubFailure>>;
  /** What `artifact` serves and `deleteArtifact` deletes. */
  artifacts: FakeArtifact[];
  /** Every run `dispatch` started, with GitHub's run id it answered. */
  dispatches: {
    projectId: string;
    workflow: string;
    inputs: Record<string, string>;
    githubRunId: number;
  }[];
  /** Every artifact `deleteArtifact` was asked to delete. */
  deleted: { projectId: string; githubRunId: number; name: string }[];
}

/** The first GitHub run id the fake answers; each dispatch takes the next. */
export const FAKE_GITHUB_RUN_ID = 7_000_000_001;

export interface FakeHost extends DevSyncHost {
  github: FakeGithub;
  agents: FakeAgents;
  ai: FakeAi;
  /**
   * The members, projects, open findings and agents `members()`, `project()`, `finding()` and
   * `agents` answer from; a test may change them (resolving a finding is removing it).
   */
  directory: {
    members: Record<string, Member[]>;
    projects: ProjectRef[];
    findings: Record<string, Finding[]>;
    agents: FakeHostAgent[];
  };
  /** What `context()` answers, whoever asks; a test may set it. */
  contextBlock: ContextBlock;
  /** Every call to `context()`. */
  contextAsked: { caller: Parameters<DevSyncHost["context"]>[0]; subject: string }[];
  /** Every event `emit` recorded, with the transaction it was given. */
  emitted: { tx: DevSyncDb; event: DevSyncEvent }[];
  audits: { actor: AuditActor; entry: AuditEntry }[];
  enqueued: {
    queue: QueueName;
    payload: Record<string, unknown>;
    options?: { singleton?: { key: string; seconds: number } };
  }[];
  errors: string[];
}

/**
 * A `DevSyncHost` on `db` with a fixed clock, recording audit entries, emitted events (with their
 * transaction), enqueued jobs (at once: the fake has no transaction to wait for) and logged errors,
 * with a fake GitHub (`FakeGithub`) whose repositories have DevSync's workflow and the Anthropic
 * key's secret. `finding()` answers a project's open finding by its fingerprint, and null for a
 * project `project()` doesn't find. `agents` answers from `directory.agents` (`FakeAgents`),
 * `context()` answers `contextBlock`, `redact()` replaces each `fakeToken()`-shaped value with
 * `[redacted]`, and `ai.allowRun()` answers `ai.run` (`FakeAi`).
 */
export function fakeHost(db: DevSyncDb, options: FakeHostOptions = {}): FakeHost {
  const now = new Date(options.now ?? FAKE_NOW).getTime();
  const host: FakeHost = {
    db,
    clock: { now: () => new Date(now) },
    log: { error: (message) => host.errors.push(message) },
    directory: {
      members: { ...options.members },
      projects: [...(options.projects ?? [])],
      findings: { ...options.findings },
      agents: [...(options.agents ?? [])],
    },
    contextBlock: { instructions: [], facts: [] },
    contextAsked: [],
    emitted: [],
    audits: [],
    enqueued: [],
    errors: [],
    async emit(tx, event) {
      host.emitted.push({ tx, event: { ...event, data: { ...event.data } } });
    },
    agents: fakeAgents(() => host),
    async context(caller, input) {
      host.contextAsked.push({ caller, subject: input.subject });
      return {
        instructions: host.contextBlock.instructions.map((e) => ({ ...e })),
        facts: host.contextBlock.facts.map((e) => ({ ...e })),
      };
    },
    redact: (text) => text.replace(TOKEN_SHAPED, REDACTED),
    ai: {
      run: { request: "fake-run-request", origin: "https://host.example" },
      asked: [],
      async allowRun(input) {
        host.ai.asked.push({ ...input });
        const project = await host.project(input.projectId);
        if (input.workflow !== WORKFLOW_FILE || !project || project.readOnly) return null;
        return { ...host.ai.run };
      },
    },
    async audit(_tx, actor, entry) {
      host.audits.push({ actor, entry });
    },
    async members(workspaceId) {
      return [...(host.directory.members[workspaceId] ?? [])];
    },
    async project(projectId) {
      return host.directory.projects.find((p) => p.projectId === projectId) ?? null;
    },
    async enqueue(queue, payload, options) {
      host.enqueued.push({ queue, payload, options });
    },
    github: fakeGithub(() => host.directory.projects),
    async finding(projectId, fingerprint) {
      if (!host.directory.projects.some((p) => p.projectId === projectId)) return null;
      return host.directory.findings[projectId]?.find((f) => f.fingerprint === fingerprint) ?? null;
    },
  };
  return host;
}

/** An agent of the fake host as a module reads it: its `AgentRef`, never its token's hash. */
function agentRef(agent: FakeHostAgent): AgentRef {
  const { agentId, projectId, workspaceId, name, kind, modules } = agent;
  return { agentId, projectId, workspaceId, name, kind, modules: [...modules] };
}

/**
 * The fake host's `agents`, over `directory.agents`: `verify` finds an agent by its token's hash
 * while it may reach DevSync, its project has DevSync on, and it is neither expired nor revoked;
 * `list` the project's agents that may reach DevSync; `adopt` refuses a row the host refuses,
 * records the rest, adds the agents it doesn't have yet (they may reach DevSync) and answers how
 * many rows it was given.
 */
function fakeAgents(hostOf: () => FakeHost): FakeAgents {
  const reaches = (agent: FakeHostAgent) => agent.modules.includes("devsync");
  const agents: FakeAgents = {
    adopted: [],
    async verify(token) {
      const host = hostOf();
      const hash = hashToken(token);
      const found = host.directory.agents.find((a) => a.tokenHash === hash);
      if (!found || !reaches(found) || found.revokedAt) return null;
      if (found.expiresAt && found.expiresAt.getTime() <= host.clock.now().getTime()) return null;
      return (await host.project(found.projectId)) ? agentRef(found) : null;
    },
    async list(projectId) {
      return hostOf()
        .directory.agents.filter((a) => a.projectId === projectId && reaches(a))
        .map(agentRef);
    },
    async adopt(tx, rows) {
      const { directory } = hostOf();
      for (const row of rows) {
        const project = directory.projects.find((p) => p.projectId === row.projectId);
        if (project?.workspaceId !== row.workspaceId) {
          throw new Error(
            `Agent ${row.agentId}'s project isn't one of its workspace's with DevSync on.`,
          );
        }
        if (!/^[0-9a-f]{64}$/.test(row.tokenHash)) {
          throw new Error(`Agent ${row.agentId}'s token hash isn't 64 hex characters.`);
        }
      }
      agents.adopted.push({ tx, agents: rows.map((row) => ({ ...row })) });
      for (const row of rows) {
        if (directory.agents.some((a) => a.agentId === row.agentId)) continue;
        directory.agents.push({
          agentId: row.agentId,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          name: row.name,
          kind: row.kind,
          modules: ["devsync"],
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        });
      }
      return rows.length;
    },
  };
  return agents;
}

/** The fake host's `github`, over the projects the host finds. */
function fakeGithub(projects: () => ProjectRef[]): FakeGithub {
  /** The refusal a call gets before anything else: a project without DevSync, a workflow not its own. */
  const refusal = (
    method: keyof DevSyncGithub,
    projectId: string,
    workflow: string = WORKFLOW_FILE,
  ): { ok: false; failure: GithubFailure } | null => {
    if (!projects().some((p) => p.projectId === projectId) || workflow !== WORKFLOW_FILE) {
      return { ok: false, failure: "not-found" };
    }
    const failure = github.fail[method];
    return failure ? { ok: false, failure } : null;
  };
  const github: FakeGithub = {
    repository: { workflow: true, secrets: ["ANTHROPIC_API_KEY"] },
    fail: {},
    artifacts: [],
    dispatches: [],
    deleted: [],
    async setup(projectId, workflow) {
      const refused = refusal("setup", projectId, workflow);
      if (refused) return refused;
      return {
        ok: true,
        workflow: github.repository.workflow,
        secrets: [...github.repository.secrets],
      };
    },
    async dispatch(projectId, workflow, inputs) {
      const refused = refusal("dispatch", projectId, workflow);
      if (refused) return refused;
      const githubRunId = FAKE_GITHUB_RUN_ID + github.dispatches.length;
      github.dispatches.push({ projectId, workflow, inputs: { ...inputs }, githubRunId });
      const fullName = projects().find((p) => p.projectId === projectId)?.fullName;
      return {
        ok: true,
        githubRunId,
        url: `https://github.com/${fullName}/actions/runs/${githubRunId}`,
      };
    },
    async artifact(projectId, githubRunId, name) {
      const refused = refusal("artifact", projectId);
      if (refused) return refused;
      const found = github.artifacts.find((a) => a.githubRunId === githubRunId && a.name === name);
      return { ok: true, files: found ? new Map(found.files) : null };
    },
    async deleteArtifact(projectId, githubRunId, name) {
      const refused = refusal("deleteArtifact", projectId);
      if (refused) return refused;
      github.deleted.push({ projectId, githubRunId, name });
      github.artifacts = github.artifacts.filter(
        (a) => !(a.githubRunId === githubRunId && a.name === name),
      );
      return { ok: true };
    },
  };
  return github;
}

/** An artifact's files from their texts, as the host unzips them. */
export function artifactFiles(files: Record<string, string>): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
}

/** A fresh random token-shaped value (32 bytes, base64url), made at run time. */
export function fakeToken(): string {
  return randomBytes(32).toString("base64url");
}
