/**
 * A project's export (`serverModule.exportProject`, docs/platform.md): DevSync's rows of the
 * project, read through the host's read-only transaction only: its tasks with their revisions,
 * comments, questions (with their answers) and the tasks they wait for (`dependsOn`, beside their
 * paths, labels and branch), its runs, its pull requests and its timeline (the outbox's events, with the usage agents reported).
 * The agents are the host's to export; the timeline names them by id. The host gives the project's
 * id only, so its workspace is the one its rows name: rows naming two workspaces stop the export,
 * which holds none of them, and every row is read by both.
 */
import { and, asc, eq } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  outboxEvent,
  pullRequest,
  question,
  run,
  task,
  taskComment,
  taskDependency,
  taskRevision,
} from "../db";
import type { DevSyncDb } from "../host";

/** One of DevSync's tables: every one has its workspace's and project's ids. */
type Scoped = PgTable & { projectId: AnyPgColumn; workspaceId: AnyPgColumn };

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

/**
 * The workspace the project's exported rows name, or null when it has none; rows naming two are a
 * fault, which stops the export.
 */
async function workspaceOf(tx: DevSyncDb, projectId: string): Promise<string | null> {
  const named = new Set<string>();
  // One query at a time: they share the host's transaction.
  for (const table of [
    task,
    taskRevision,
    taskComment,
    question,
    taskDependency,
    run,
    pullRequest,
    outboxEvent,
  ] satisfies Scoped[]) {
    const rows = await tx
      .selectDistinct({ workspaceId: table.workspaceId })
      .from(table as Scoped)
      .where(eq(table.projectId, projectId));
    for (const row of rows) named.add(String(row.workspaceId));
  }
  if (named.size > 1) {
    throw new Error(
      `Project ${projectId}'s DevSync rows name ${named.size} workspaces, so its export stops: a row of it was written under another workspace.`,
    );
  }
  return [...named][0] ?? null;
}

/** The project's DevSync rows, as JSON once the host serializes them. */
export async function exportProject(tx: DevSyncDb, projectId: string) {
  const workspaceId = await workspaceOf(tx, projectId);
  if (workspaceId === null) return { tasks: [], runs: [], pullRequests: [], timeline: [] };
  const of = (table: Scoped) =>
    and(eq(table.projectId, projectId), eq(table.workspaceId, workspaceId));
  // One query at a time: they share the host's transaction.
  const tasks = await tx
    .select()
    .from(task)
    .where(of(task))
    .orderBy(asc(task.createdAt), asc(task.id));
  const revisions = await tx
    .select()
    .from(taskRevision)
    .where(of(taskRevision))
    .orderBy(asc(taskRevision.taskId), asc(taskRevision.number));
  const comments = await tx
    .select()
    .from(taskComment)
    .where(of(taskComment))
    .orderBy(asc(taskComment.createdAt), asc(taskComment.id));
  const questions = await tx
    .select()
    .from(question)
    .where(of(question))
    .orderBy(asc(question.createdAt), asc(question.id));
  const dependencies = await tx
    .select({ taskId: taskDependency.taskId, dependsOnTaskId: taskDependency.dependsOnTaskId })
    .from(taskDependency)
    .where(of(taskDependency))
    .orderBy(asc(taskDependency.taskId), asc(taskDependency.position));
  const runs = await tx.select().from(run).where(of(run)).orderBy(asc(run.createdAt), asc(run.id));
  const pullRequests = await tx
    .select()
    .from(pullRequest)
    .where(of(pullRequest))
    .orderBy(asc(pullRequest.number));
  const timeline = await tx
    .select()
    .from(outboxEvent)
    .where(of(outboxEvent))
    .orderBy(asc(outboxEvent.createdAt), asc(outboxEvent.id));
  const revisionsOf = byTask(revisions);
  const commentsOf = byTask(comments);
  const questionsOf = byTask(questions);
  const dependenciesOf = byTask(dependencies);
  return {
    tasks: tasks.map((row) => ({
      ...row,
      dependsOn: (dependenciesOf.get(row.id) ?? []).map((d) => d.dependsOnTaskId),
      revisions: revisionsOf.get(row.id) ?? [],
      comments: commentsOf.get(row.id) ?? [],
      questions: questionsOf.get(row.id) ?? [],
    })),
    runs,
    pullRequests,
    timeline,
  };
}
