/**
 * What DevSync needs from its host, OpsCrew's dashboard (docs/host.md). DevSync never imports the
 * host's code: the host implements this interface and mounts DevSync's routes, queues, migrations
 * and removal hooks. Tests implement it with `fakeHost()` from `@devsync/server/testing`.
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

/** The Hono environments of DevSync's routes: the host sets `devsync` before they run. */
export type ProjectEnv = { Variables: { devsync: ProjectContext } };
export type WorkspaceEnv = { Variables: { devsync: WorkspaceContext } };

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
export type QueueName = "devsync.outbox" | "devsync.github";

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
