/**
 * A project's export (`serverModule.exportProject`, docs/platform.md): DevSync's rows of the
 * project, read through the host's read-only transaction only. Its tasks with their revisions and
 * comments, its runs, its pull requests, its timeline (the outbox's events) and its agents, never
 * an agent's token hash or expiry.
 */
import { asc, eq } from "drizzle-orm";
import { agent, outboxEvent, pullRequest, run, task, taskComment, taskRevision } from "../db";
import type { DevSyncDb } from "../host";

/** Rows by their task's id, in their order. */
function byTask<T extends { taskId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.taskId);
    if (list) list.push(row);
    else grouped.set(row.taskId, [row]);
  }
  return grouped;
}

/** The project's DevSync rows, as JSON once the host serializes them. */
export async function exportProject(tx: DevSyncDb, projectId: string) {
  // One query at a time: they share the host's transaction.
  const tasks = await tx
    .select()
    .from(task)
    .where(eq(task.projectId, projectId))
    .orderBy(asc(task.createdAt), asc(task.id));
  const revisions = await tx
    .select()
    .from(taskRevision)
    .where(eq(taskRevision.projectId, projectId))
    .orderBy(asc(taskRevision.taskId), asc(taskRevision.number));
  const comments = await tx
    .select()
    .from(taskComment)
    .where(eq(taskComment.projectId, projectId))
    .orderBy(asc(taskComment.createdAt), asc(taskComment.id));
  const runs = await tx
    .select()
    .from(run)
    .where(eq(run.projectId, projectId))
    .orderBy(asc(run.createdAt), asc(run.id));
  const pullRequests = await tx
    .select()
    .from(pullRequest)
    .where(eq(pullRequest.projectId, projectId))
    .orderBy(asc(pullRequest.number));
  const timeline = await tx
    .select()
    .from(outboxEvent)
    .where(eq(outboxEvent.projectId, projectId))
    .orderBy(asc(outboxEvent.createdAt), asc(outboxEvent.id));
  const agents = await tx
    .select({
      id: agent.id,
      workspaceId: agent.workspaceId,
      projectId: agent.projectId,
      name: agent.name,
      kind: agent.kind,
      revokedAt: agent.revokedAt,
      lastSeenAt: agent.lastSeenAt,
      registeredByUserId: agent.registeredByUserId,
      createdAt: agent.createdAt,
    })
    .from(agent)
    .where(eq(agent.projectId, projectId))
    .orderBy(asc(agent.createdAt), asc(agent.id));
  const revisionsOf = byTask(revisions);
  const commentsOf = byTask(comments);
  return {
    tasks: tasks.map((row) => ({
      ...row,
      revisions: revisionsOf.get(row.id) ?? [],
      comments: commentsOf.get(row.id) ?? [],
    })),
    runs,
    pullRequests,
    timeline,
    agents,
  };
}
