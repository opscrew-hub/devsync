/**
 * The removal hooks the host calls in its own removal transaction (docs/host.md, Migrations and
 * removal): a project's or a workspace's DevSync rows are deleted from every table, and a member who
 * leaves the workspace is unassigned from its tasks.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  agent,
  githubDelivery,
  outboxEvent,
  pullRequest,
  run,
  signal,
  task,
  taskComment,
  taskRevision,
} from "./db";
import type { DevSyncDb } from "./host";

/** Every DevSync table, children before the rows they reference. */
const TABLES = [
  signal,
  outboxEvent,
  run,
  taskComment,
  taskRevision,
  task,
  agent,
  pullRequest,
  githubDelivery,
] as const;

async function removeRows(db: DevSyncDb, column: "projectId" | "workspaceId", id: string) {
  await db.transaction(async (tx) => {
    for (const table of TABLES) {
      await tx.delete(table).where(eq(table[column], id));
    }
  });
}

/** Deletes every DevSync row of the project. */
export function removeProject(db: DevSyncDb, projectId: string): Promise<void> {
  return removeRows(db, "projectId", projectId);
}

/** Deletes every DevSync row of the workspace, all its projects'. */
export function removeWorkspace(db: DevSyncDb, workspaceId: string): Promise<void> {
  return removeRows(db, "workspaceId", workspaceId);
}

/** Unassigns a member who left the workspace from its tasks (each task's version bumped). */
export async function removeMember(
  db: DevSyncDb,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await db
    .update(task)
    .set({ assigneeUserId: null, version: sql`${task.version} + 1` })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.assigneeUserId, userId)));
}
