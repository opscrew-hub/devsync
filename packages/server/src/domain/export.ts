/**
 * A project's export (`serverModule.exportProject`, docs/platform.md): DevSync's rows of the
 * project, read through the host's read-only transaction only: its tasks with their revisions,
 * comments and the tasks they wait for (`dependsOn`, beside their paths, labels and branch), its
 * runs, its pull requests and its timeline (the outbox's events, with the usage agents reported).
 * The agents are the host's to export; the timeline names them by id.
 */
import { asc, eq } from "drizzle-orm";
import {
  outboxEvent,
  pullRequest,
  run,
  task,
  taskComment,
  taskDependency,
  taskRevision,
} from "../db";
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
  const dependencies = await tx
    .select({ taskId: taskDependency.taskId, dependsOnTaskId: taskDependency.dependsOnTaskId })
    .from(taskDependency)
    .where(eq(taskDependency.projectId, projectId))
    .orderBy(asc(taskDependency.taskId), asc(taskDependency.position));
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
  const revisionsOf = byTask(revisions);
  const commentsOf = byTask(comments);
  const dependenciesOf = byTask(dependencies);
  return {
    tasks: tasks.map((row) => ({
      ...row,
      dependsOn: (dependenciesOf.get(row.id) ?? []).map((d) => d.dependsOnTaskId),
      revisions: revisionsOf.get(row.id) ?? [],
      comments: commentsOf.get(row.id) ?? [],
    })),
    runs,
    pullRequests,
    timeline,
  };
}
