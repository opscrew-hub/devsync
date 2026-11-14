/**
 * `@devsync/server/testing`: an in-memory PostgreSQL (PGlite) with DevSync's migration applied as
 * the host applies it, a fake host, and fresh token-shaped values, so no test commits one.
 */
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrations } from "./db";
import type {
  AuditActor,
  AuditEntry,
  DevSyncDb,
  DevSyncHost,
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
  /** The clock's fixed time, ISO 8601. */
  now?: string;
}

export interface FakeHost extends DevSyncHost {
  /** The members and projects `members()` and `project()` answer from; a test may change them. */
  directory: { members: Record<string, Member[]>; projects: ProjectRef[] };
  audits: { actor: AuditActor; entry: AuditEntry }[];
  enqueued: {
    queue: QueueName;
    payload: Record<string, unknown>;
    options?: { singleton?: { key: string; seconds: number } };
  }[];
  errors: string[];
}

/**
 * A `DevSyncHost` on `db` with a fixed clock, recording audit entries, enqueued jobs (at once: the
 * fake has no transaction to wait for) and logged errors.
 */
export function fakeHost(db: DevSyncDb, options: FakeHostOptions = {}): FakeHost {
  const now = new Date(options.now ?? FAKE_NOW).getTime();
  const host: FakeHost = {
    db,
    clock: { now: () => new Date(now) },
    log: { error: (message) => host.errors.push(message) },
    directory: { members: { ...options.members }, projects: [...(options.projects ?? [])] },
    audits: [],
    enqueued: [],
    errors: [],
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
  };
  return host;
}

/** A fresh random token-shaped value (32 bytes, base64url), made at run time. */
export function fakeToken(): string {
  return randomBytes(32).toString("base64url");
}
