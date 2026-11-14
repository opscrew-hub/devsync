/**
 * What DevSync needs from its host, OpsCrew's dashboard (docs/host.md). DevSync never imports the
 * host's code: the host's `ModuleHost`, which it builds for every module, satisfies this interface
 * (the contract's wider `string` action and queue parameters accept DevSync's), and it mounts the
 * routes, queues, migrations and removal hooks `serverModule` (module.ts) gives it. Tests implement
 * it with `fakeHost()` from `@devsync/server/testing`.
 */
import type { Role } from "@devsync/schemas";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * The host's database, or a transaction on it: DevSync's tables live in the `devsync` schema of
 * the same database, so a DevSync transaction is the host's and the host's audit entry commits with
 * it. DevSync uses Drizzle's query builder only (never `db.query`), so the host's schema type
 * doesn't matter here.
 */
// biome-ignore lint/suspicious/noExplicitAny: the host's own schema type, which DevSync never reads.
export type DevSyncDb = PgDatabase<PgQueryResultHKT, any>;

/** A member of the host's workspace, with their role there. */
export interface Member {
  userId: string;
  name: string;
  role: Role;
}

/** A project of the host's workspace with DevSync on. */
export interface ProjectRef {
  workspaceId: string;
  projectId: string;
  /** The repository's `owner/name`. */
  fullName: string;
  /** Past the workspace's plan: readable, but the host refuses members' changes, and DevSync refuses agents' writes. */
  readOnly: boolean;
}

/** Who asks on a project route: set by the host from its session, never from the request. */
export interface ProjectContext {
  project: ProjectRef;
  member: Member;
}

/** Who asks on a workspace route, and the workspace's projects with DevSync on. */
export interface WorkspaceContext {
  workspaceId: string;
  member: Member;
  projects: ProjectRef[];
}

/**
 * An agent, authenticated by its token (`authenticateAgent`): what the MCP endpoint passes the
 * domain where a member's route passes a `ProjectContext`.
 */
export interface AgentActor {
  kind: "agent";
  agentId: string;
  name: string;
  project: ProjectRef;
}

/** The Hono environments of DevSync's routes: the host's guard sets `module` before they run. */
export type ProjectEnv = { Variables: { module: ProjectContext } };
export type WorkspaceEnv = { Variables: { module: WorkspaceContext } };

/** What the audit log records: names, ids and figures only, never a token. */
export interface AuditEntry {
  workspaceId: string;
  projectId: string;
  action: `devsync.${string}`;
  detail: Record<string, string | number | boolean | null>;
}

/** Who did it: a member, or the host itself (a queue). */
export type AuditActor = { userId: string } | "host";

/** DevSync's queues, run by the host's worker. */
export type QueueName = "devsync.outbox" | "devsync.github" | "devsync.runs";

/**
 * One GitHub delivery for a project with DevSync on, as the host forwards it on `devsync.github`
 * (the contract's `GithubFact`). A `workflow_run` fact comes only for a completed run DevSync
 * started (`github.dispatch`), while DevSync is on for the project.
 */
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

/** A `devsync.github` job's payload (the contract's `ModuleGithubJob`). */
export interface GithubJob {
  workspaceId: string;
  projectId: string;
  fact: GithubFact;
}

/** Why a call to the project's Actions failed (the contract's `GithubFailure`). */
export type GithubFailure =
  /** The project isn't connected, or DevSync is off for it. */
  | "not-found"
  /** The host has no GitHub App, or GitHub didn't answer. */
  | "unavailable"
  /** The workflow file isn't on the default branch. */
  | "workflow-missing"
  /** The workflow is disabled, or GitHub refused its inputs. */
  | "workflow-disabled"
  /** Actions is off for the repository, or the host's App can't start the workflow. */
  | "forbidden";

/**
 * DevSync's workflow (`serverModule.workflows`) in a project's repository, through the host's
 * GitHub App (the contract's `ModuleGithub`). Every call takes a project with DevSync on and the
 * workflow file DevSync declared; none throws GitHub's errors.
 */
export interface DevSyncGithub {
  /** The workflow file on the default branch, and the names of the Actions secrets its runs can read. */
  setup(
    projectId: string,
    workflow: string,
  ): Promise<
    { ok: true; workflow: boolean; secrets: string[] } | { ok: false; failure: GithubFailure }
  >;
  /** Starts the workflow on the default branch with `inputs` and records the run for DevSync. */
  dispatch(
    projectId: string,
    workflow: string,
    inputs: Record<string, string>,
  ): Promise<
    { ok: true; githubRunId: number; url: string } | { ok: false; failure: GithubFailure }
  >;
  /** The files of the artifact `name` of a run DevSync started in the project; null when it has none. */
  artifact(
    projectId: string,
    githubRunId: number,
    name: string,
  ): Promise<
    { ok: true; files: Map<string, Uint8Array> | null } | { ok: false; failure: GithubFailure }
  >;
  /** Deletes that artifact; a missing one counts as deleted. */
  deleteArtifact(
    projectId: string,
    githubRunId: number,
    name: string,
  ): Promise<{ ok: true } | { ok: false; failure: GithubFailure }>;
}

export interface DevSyncHost {
  db: DevSyncDb;
  clock: { now(): Date };
  log: { error(message: string): void };
  /** Appends an entry to the host's audit log, in the transaction `tx` that makes the change. */
  audit(tx: DevSyncDb, actor: AuditActor, entry: AuditEntry): Promise<void>;
  /** The workspace's members as they are now: who can be assigned a task. */
  members(workspaceId: string): Promise<Member[]>;
  /**
   * The project with DevSync on for it and its workspace, or null (gone, disconnected, or DevSync
   * off): what the MCP endpoint checks for an agent's project on every request.
   */
  project(projectId: string): Promise<ProjectRef | null>;
  /**
   * Sends a job to one of DevSync's queues once the current transaction commits (at once outside
   * one; never if it rolls back). Payloads hold ids only.
   */
  enqueue(
    queue: QueueName,
    payload: Record<string, unknown>,
    options?: { singleton?: { key: string; seconds: number } },
  ): Promise<void>;
  /** DevSync's workflow in the project's repository: its managed runs. */
  github: DevSyncGithub;
}

/** The error codes DevSync answers with, and their HTTP statuses: the dashboard's own. */
export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  invalid: 422,
  "rate-limited": 429,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * A refusal: answered `{ error: { code, message, fields? } }` with the code's status. The message
 * is plain English and says what to do next; `fields` names invalid fields, never their values.
 */
export class DevSyncError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: string[],
  ) {
    super(message);
  }
}
