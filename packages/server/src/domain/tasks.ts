/**
 * Tasks: create, read, edit, move, assign, comment and link a pull request, for a project's members
 * (a `ProjectContext`) and its agents (an `AgentActor`). The rules: the lifecycle, the version
 * check, a revision per requirements change, a claimed task's status changed only by its claim, the
 * creator's `requestId` idempotency, an agent's requirements through the host's redactor, and an
 * outbox event per change recorded (with its host events) in its transaction. A task's fields
 * beyond its requirements (its paths, the tasks it waits for, its labels and branch) change with no
 * revision; the tasks it waits for are the project's, never itself, and never in a circle. A task
 * holds at most 200 revisions and 500 comments, its detail lists the newest of its histories with a
 * count of the rest, the lists answer pages of 100 at most, and an agent's creates and edits count
 * against its 20 a minute. Every query filters by the project.
 */
import {
  AgentTaskInput,
  AgentTaskUpdate,
  AgentUsage,
  type Author,
  type Comment,
  CommentInput,
  type Finding,
  Id,
  type PullRequest,
  PullRequestLink,
  type Revision,
  RunUsage,
  STATUS_LABEL,
  TASK_PAGE,
  type Task,
  type TaskDetail,
  TaskFields,
  TaskInput,
  type TaskList,
  TaskListQuery,
  type TaskStatus,
  type TaskSummary,
  TaskUpdate,
  type TimelineEvent,
  Timestamp,
  TRANSITIONS,
  type UsageTotal,
  type WorkspaceTaskList,
  WorkspaceTaskListQuery,
} from "@devsync/schemas";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import {
  agent,
  outboxEvent,
  type PullRequestRow,
  pullRequest,
  run,
  type TaskRow,
  task,
  taskComment,
  taskDependency,
  taskRevision,
} from "../db";
import {
  type AgentActor,
  type AuditActor,
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type ProjectContext,
  type ProjectRef,
  type WorkspaceContext,
} from "../host";
import {
  authorOf,
  countTaskWrite,
  hostFinding,
  lockAgentRow,
  type Names,
  namesOf,
  noSuchTask,
  parse,
  REMOVED_AGENT,
  requireRole,
  requireWritable,
  taskIdOf,
  taskIn,
} from "./common";
import { type OutboxActor, outbox } from "./outbox";
import { questionAgentIds, releaseWaitingQuestions, taskQuestions, toQuestion } from "./questions";

/** Who acts on a task: a member on a project route, or an agent through MCP. */
export type TaskActor = ProjectContext | AgentActor;

/** Who reads a project's tasks: a member, an agent, or a managed run (its project only). */
export type TaskReader = TaskActor | Pick<TaskActor, "project">;

const TASK_CHANGED = "This task changed. Reload it and try again.";
/** How many of a task's latest events its timeline shows. */
const TIMELINE_LIMIT = 100;
/** How many of a task's newest requirements revisions its detail lists. */
const REVISIONS_LISTED = 50;
/** How many of a task's newest comments its detail lists. */
const COMMENTS_LISTED = 100;
/** How many of the open tasks sharing a task's paths its detail lists: the oldest. */
export const OVERLAPS_LISTED = 20;
/** The most requirements revisions a task holds: a change past them is refused. */
const REVISION_LIMIT = 200;
/** The most comments a task holds: one more is refused. */
const COMMENT_LIMIT = 500;

/** A member's task: `POST /tasks`' body, or `create_task`'s with its `requestId`. */
const MemberTaskInput = TaskInput.extend({ requestId: Id.optional() });

/** An agent's `update_task` fields, its task id given apart. */
const AgentUpdateFields = AgentTaskUpdate.omit({ taskId: true });
export type AgentUpdateFields = z.infer<typeof AgentUpdateFields>;

function isAgent(actor: TaskActor): actor is AgentActor {
  return "kind" in actor && actor.kind === "agent";
}

/** A task's requirements, or some of them. */
type Requirements = { title?: string; description?: string; acceptanceCriteria?: string };

/** An agent's requirements, each through the host's redactor before it is stored or compared. */
function redactRequirements<T extends Requirements>(host: DevSyncHost, fields: T): T {
  return {
    ...fields,
    ...(fields.title === undefined ? {} : { title: host.redact(fields.title) }),
    ...(fields.description === undefined ? {} : { description: host.redact(fields.description) }),
    ...(fields.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: host.redact(fields.acceptanceCriteria) }),
  };
}

/** The fields of `TaskFields` that `input` gives, and no other key. */
function fieldsOf(input: TaskFields): TaskFields {
  const fields: TaskFields = {};
  if (input.owns !== undefined) fields.owns = input.owns;
  if (input.dependsOn !== undefined) fields.dependsOn = input.dependsOn;
  if (input.labels !== undefined) fields.labels = input.labels;
  if (input.branch !== undefined) fields.branch = input.branch;
  return fields;
}

/**
 * An agent's paths, labels and branch through the host's redactor, then checked again: what the
 * redactor left must still be a path, a label or a branch name, or it is refused by the field.
 */
function redactFields(host: DevSyncHost, fields: TaskFields): TaskFields {
  const redact = (text: string) => host.redact(text);
  return parse(TaskFields, {
    ...fields,
    ...(fields.owns === undefined ? {} : { owns: fields.owns.map(redact) }),
    ...(fields.labels === undefined ? {} : { labels: fields.labels.map(redact) }),
    ...(fields.branch ? { branch: redact(fields.branch) } : {}),
  });
}

/** An agent's edit: its requirements and fields through the host's redactor. */
function agentUpdate(host: DevSyncHost, update: AgentUpdateFields): TaskUpdate {
  return { ...redactRequirements(host, update), ...redactFields(host, fieldsOf(update)) };
}

/** The statuses of a task that is no longer open. */
const CLOSED: readonly TaskStatus[] = ["DONE", "CANCELLED"];

// --- Answers ------------------------------------------------------------------------------------

/**
 * A task as `selectTasks` reads it: its row, the claiming agent's name (if the row has a claim)
 * and the tasks it waits for, in their order.
 */
export interface SelectedTask {
  task: TaskRow;
  claimAgentName: string | null;
  dependsOn: string[];
}

/** A selected task as `Task`. */
export function toTask({ task: row, claimAgentName, dependsOn }: SelectedTask): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    revision: row.revision,
    version: row.version,
    assigneeUserId: row.assigneeUserId,
    claim:
      row.claimAgentId && row.claimExpiresAt
        ? {
            agentId: row.claimAgentId,
            agentName: claimAgentName ?? REMOVED_AGENT,
            expiresAt: row.claimExpiresAt.toISOString(),
          }
        : null,
    pullRequestNumber: row.pullRequestNumber,
    owns: row.owns,
    dependsOn,
    labels: row.labels,
    branch: row.branch,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A `pull_request` row as `PullRequest`, its time GitHub's. */
export function toPullRequest(row: PullRequestRow): PullRequest {
  return {
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    updatedAt: row.sourceUpdatedAt.toISOString(),
  };
}

function requiredAuthor(names: Names, userId: string | null, agentId: string | null): Author {
  const author = authorOf(names, userId, agentId);
  if (!author) throw new Error("A task's creator or revision has no author.");
  return author;
}

// --- Checks -------------------------------------------------------------------------------------

/** Refuses a write to a read-only project, and a member whose role may not change tasks. */
function requireWrite(actor: TaskActor): void {
  requireWritable(actor.project);
  if (!isAgent(actor)) requireRole(actor.member.role, "task.write");
}

function actorIds(actor: TaskActor): NonNullable<OutboxActor> {
  return isAgent(actor) ? { agentId: actor.agentId } : { userId: actor.member.userId };
}

function statusList(statuses: readonly TaskStatus[]): string {
  const names = statuses.map((status) => STATUS_LABEL[status]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : `${names[0]}`;
}

function moveRefusal(from: TaskStatus, to: TaskStatus): DevSyncError {
  const next = TRANSITIONS[from];
  return new DevSyncError(
    "conflict",
    next.length === 0
      ? `This task is ${STATUS_LABEL[from]}, which is final: it can't move to ${STATUS_LABEL[to]}.`
      : `A task can't move from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}. From ${STATUS_LABEL[from]} it can move to ${statusList(next)}.`,
  );
}

// --- Reads --------------------------------------------------------------------------------------

/** The ids of the tasks a task waits for, in their order: a subquery of the task's row. */
const dependsOnColumn = sql<string[]>`coalesce(
  (select array_agg(${taskDependency.dependsOnTaskId}::text order by ${taskDependency.position})
    from ${taskDependency} where ${taskDependency.taskId} = ${task.id}),
  '{}'::text[])`;

/**
 * The tasks matching `where` with their claiming agents' names and the tasks they wait for, most
 * recently updated first: every list of tasks DevSync answers, an agent's project state's too.
 */
export function selectTasks(db: DevSyncDb, where: SQL | undefined) {
  return db
    .select({ task, claimAgentName: agent.name, dependsOn: dependsOnColumn })
    .from(task)
    .leftJoin(agent, and(eq(agent.id, task.claimAgentId), eq(agent.projectId, task.projectId)))
    .where(where)
    .orderBy(desc(task.updatedAt), desc(task.id));
}

/**
 * A page's cursor: its last task's `updatedAt` and id, base64url, which the next page starts after
 * in `selectTasks`' order.
 */
function cursorOf(row: TaskRow): string {
  return Buffer.from(`${row.updatedAt.toISOString()}_${row.id}`).toString("base64url");
}

/** The tasks after `cursor` in `selectTasks`' order; one DevSync didn't give is refused. */
function afterCursor(cursor: string | undefined): SQL | undefined {
  if (cursor === undefined) return undefined;
  const [at = "", id = "", ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("_");
  if (rest.length > 0 || !Timestamp.safeParse(at).success || !Id.safeParse(id).success) {
    throw new DevSyncError(
      "invalid",
      "This cursor isn't one DevSync gave. Read the list again from its first page.",
      ["cursor"],
    );
  }
  const when = new Date(at);
  return or(lt(task.updatedAt, when), and(eq(task.updatedAt, when), lt(task.id, id)));
}

/** A page of `limit` of `rows` (read with one more), and the next page's cursor, or null. */
function pageOf(rows: SelectedTask[], limit: number) {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { shown, nextCursor: rows.length > limit && last ? cursorOf(last.task) : null };
}

async function loadTask(db: DevSyncDb, project: ProjectRef, taskId: string): Promise<Task> {
  const [row] = await selectTasks(db, taskIn(project, taskId));
  if (!row) throw noSuchTask();
  return toTask(row);
}

/**
 * The open task (neither Done nor Cancelled) linked to a security finding, the latest updated:
 * made from the same fingerprint, or, since the fingerprint includes the line and changes when code
 * above it moves, from a finding with the same rule and file. Null when there is none, so a new task
 * may be made from the finding.
 */
export async function linkedTask(
  db: DevSyncDb,
  project: ProjectRef,
  finding: Pick<Finding, "fingerprint" | "ruleId" | "file">,
): Promise<Task | null> {
  const [row] = await selectTasks(
    db,
    and(
      eq(task.projectId, project.projectId),
      eq(task.workspaceId, project.workspaceId),
      notInArray(task.status, ["DONE", "CANCELLED"]),
      or(
        eq(task.findingFingerprint, finding.fingerprint),
        and(
          eq(task.findingRule, finding.ruleId),
          finding.file === null ? isNull(task.findingFile) : eq(task.findingFile, finding.file),
        ),
      ),
    ),
  ).limit(1);
  return row ? toTask(row) : null;
}

function assigneeFilter(
  reader: TaskReader | WorkspaceContext,
  assignee: string | undefined,
): SQL | undefined {
  if (assignee === undefined) return undefined;
  if (assignee === "none") return isNull(task.assigneeUserId);
  if (assignee === "me") {
    if (!("member" in reader)) {
      throw new DevSyncError(
        "invalid",
        "Only a member has tasks assigned to them. Leave out `assignee`, or give a member's user id.",
        ["assignee"],
      );
    }
    return eq(task.assigneeUserId, reader.member.userId);
  }
  return eq(task.assigneeUserId, assignee);
}

/**
 * `GET /tasks` and `list_tasks`: a page of the project's tasks (`limit`, 100 at most and by
 * default), most recently updated first, by status and assignee (`me` for a member only), from a
 * page's `nextCursor`.
 */
export async function listTasks(
  host: DevSyncHost,
  actor: TaskReader,
  query: TaskListQuery = {},
): Promise<TaskList> {
  const { status, assignee, limit = TASK_PAGE, cursor } = parse(TaskListQuery, query);
  const rows = await selectTasks(
    host.db,
    and(
      eq(task.projectId, actor.project.projectId),
      eq(task.workspaceId, actor.project.workspaceId),
      status ? eq(task.status, status) : undefined,
      assigneeFilter(actor, assignee),
      afterCursor(cursor),
    ),
  ).limit(limit + 1);
  const { shown, nextCursor } = pageOf(rows, limit);
  return { tasks: shown.map(toTask), nextCursor };
}

/**
 * The workspace's `GET /tasks`: a page of the tasks of its projects with DevSync on (or of one of
 * them), by status (the open ones without it) and assignee, each with its project's name, paged as
 * `listTasks`.
 */
export async function listWorkspaceTasks(
  host: DevSyncHost,
  ctx: WorkspaceContext,
  query: WorkspaceTaskListQuery = {},
): Promise<WorkspaceTaskList> {
  const {
    project,
    status,
    assignee,
    limit = TASK_PAGE,
    cursor,
  } = parse(WorkspaceTaskListQuery, query);
  const projects = ctx.projects.filter(
    (p) => p.workspaceId === ctx.workspaceId && (!project || p.projectId === project),
  );
  if (project && projects.length === 0) {
    throw new DevSyncError(
      "not-found",
      "There's no such project with DevSync on in this workspace. Pick one from the list.",
    );
  }
  if (projects.length === 0) return { tasks: [], nextCursor: null };
  const names = new Map(projects.map((p) => [p.projectId, p.fullName]));
  const rows = await selectTasks(
    host.db,
    and(
      eq(task.workspaceId, ctx.workspaceId),
      inArray(task.projectId, [...names.keys()]),
      status ? eq(task.status, status) : notInArray(task.status, ["DONE", "CANCELLED"]),
      assigneeFilter(ctx, assignee),
      afterCursor(cursor),
    ),
  ).limit(limit + 1);
  const { shown, nextCursor } = pageOf(rows, limit);
  return {
    tasks: shown.map((row) => ({
      ...toTask(row),
      projectName: names.get(row.task.projectId) ?? "",
    })),
    nextCursor,
  };
}

// --- The tasks it waits for, overlapping paths and usage -----------------------------------------

/** The tasks `taskId` waits for, in their order, each with its status. */
function dependenciesOf(
  db: DevSyncDb,
  project: ProjectRef,
  taskId: string,
): Promise<TaskSummary[]> {
  return db
    .select({ id: task.id, title: task.title, status: task.status })
    .from(taskDependency)
    .innerJoin(
      task,
      and(
        eq(task.id, taskDependency.dependsOnTaskId),
        eq(task.projectId, taskDependency.projectId),
      ),
    )
    .where(and(eq(taskDependency.taskId, taskId), eq(taskDependency.projectId, project.projectId)))
    .orderBy(asc(taskDependency.position));
}

/**
 * The path two tasks share when one owns `a` and the other `b`, or null: the path itself when they
 * are the same, or the one inside the other's folder (a path ending in `/`).
 */
function sharedPath(a: string, b: string): string | null {
  if (a === b) return a;
  if (a.endsWith("/") && b.startsWith(a)) return b;
  if (b.endsWith("/") && a.startsWith(b)) return a;
  return null;
}

/** The paths two tasks owning `mine` and `theirs` share, each once, sorted. */
export function sharedPaths(mine: readonly string[], theirs: readonly string[]): string[] {
  const shared = new Set<string>();
  for (const a of mine) {
    for (const b of theirs) {
      const path = sharedPath(a, b);
      if (path !== null) shared.add(path);
    }
  }
  return [...shared].sort();
}

/**
 * While `row` is open, the project's other open tasks whose paths overlap its own, oldest first,
 * each with the paths they share.
 */
async function overlapsOf(
  db: DevSyncDb,
  project: ProjectRef,
  row: TaskRow,
): Promise<TaskDetail["overlaps"]> {
  if (row.owns.length === 0 || CLOSED.includes(row.status)) return [];
  const others = await db
    .select({ id: task.id, title: task.title, status: task.status, owns: task.owns })
    .from(task)
    .where(
      and(
        eq(task.projectId, project.projectId),
        eq(task.workspaceId, project.workspaceId),
        ne(task.id, row.id),
        notInArray(task.status, [...CLOSED]),
        sql`cardinality(${task.owns}) > 0`,
      ),
    )
    .orderBy(asc(task.createdAt), asc(task.id));
  return others.flatMap(({ owns, ...other }) => {
    const paths = sharedPaths(row.owns, owns);
    return paths.length === 0 ? [] : [{ task: other, paths }];
  });
}

/** One report's or run's usage, as `totalOf` adds it up. */
interface UsagePart {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  models: string[];
}

/** The sum of `parts`, a figure left out counting 0, or null when there are none. */
function totalOf(parts: UsagePart[]): UsageTotal | null {
  if (parts.length === 0) return null;
  const sum = (key: Exclude<keyof UsagePart, "models">) =>
    parts.reduce((total, part) => total + (part[key] ?? 0), 0);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheCreationInputTokens: sum("cacheCreationInputTokens"),
    cacheReadInputTokens: sum("cacheReadInputTokens"),
    // To the millionth of a dollar, so adding up costs leaves no binary noise.
    costUsd: Math.round(sum("costUsd") * 1e6) / 1e6,
    models: [...new Set(parts.flatMap((part) => part.models))].sort(),
    count: parts.length,
  };
}

/**
 * The usage the task's agents reported with their progress reports and review requests (their own
 * estimates), and apart from it its managed runs'. A stored value that doesn't parse counts none.
 */
async function usageOf(
  db: DevSyncDb,
  project: ProjectRef,
  taskId: string,
): Promise<TaskDetail["usage"]> {
  const [reports, runs] = await Promise.all([
    db
      .select({ usage: outboxEvent.usage })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.projectId, project.projectId),
          eq(outboxEvent.taskId, taskId),
          isNotNull(outboxEvent.usage),
        ),
      ),
    db
      .select({ usage: run.tokenUsage })
      .from(run)
      .where(
        and(
          eq(run.projectId, project.projectId),
          eq(run.taskId, taskId),
          isNotNull(run.tokenUsage),
        ),
      ),
  ]);
  const agents = reports.flatMap(({ usage }): UsagePart[] => {
    const parsed = AgentUsage.safeParse(usage);
    if (!parsed.success) return [];
    const { model, ...figures } = parsed.data;
    return [{ ...figures, models: model ? [model] : [] }];
  });
  const managed = runs.flatMap(({ usage }): UsagePart[] => {
    const parsed = RunUsage.safeParse(usage);
    return parsed.success ? [parsed.data] : [];
  });
  return { agents: totalOf(agents), runs: totalOf(managed) };
}

/**
 * `GET /tasks/:taskId` and `get_task`: the task with its requirements, creator, 50 newest
 * revisions and 100 newest comments (newest first), its questions (every open one, then its 50 most
 * recently asked answered ones), its timeline (its 100 latest outbox events, oldest first), its
 * linked pull request, the tasks it waits for, the 20 oldest open tasks whose paths overlap its own,
 * and its usage; with how many older answered questions, revisions, comments and events, and later
 * overlaps, it leaves out, so its size is bounded whatever the task's history.
 * It depends on the project only, so every reader reads the same.
 */
export async function getTask(
  host: DevSyncHost,
  actor: TaskReader,
  taskId: string,
): Promise<TaskDetail> {
  const { project } = actor;
  const [found] = await selectTasks(host.db, taskIn(project, taskIdOf(taskId)));
  if (!found) throw noSuchTask();
  const row = found.task;
  const ofRevisions = and(
    eq(taskRevision.taskId, row.id),
    eq(taskRevision.projectId, project.projectId),
  );
  const ofComments = and(
    eq(taskComment.taskId, row.id),
    eq(taskComment.projectId, project.projectId),
  );
  const ofEvents = and(
    eq(outboxEvent.taskId, row.id),
    eq(outboxEvent.projectId, project.projectId),
  );
  const [
    revisions,
    comments,
    events,
    pull,
    members,
    dependencies,
    overlaps,
    usage,
    questions,
    counts,
  ] = await Promise.all([
    host.db
      .select()
      .from(taskRevision)
      .where(ofRevisions)
      .orderBy(desc(taskRevision.number))
      .limit(REVISIONS_LISTED),
    host.db
      .select()
      .from(taskComment)
      .where(ofComments)
      .orderBy(desc(taskComment.createdAt), desc(taskComment.id))
      .limit(COMMENTS_LISTED),
    host.db
      .select()
      .from(outboxEvent)
      .where(ofEvents)
      .orderBy(desc(outboxEvent.createdAt), desc(outboxEvent.id))
      .limit(TIMELINE_LIMIT),
    row.pullRequestNumber === null
      ? Promise.resolve([])
      : host.db
          .select()
          .from(pullRequest)
          .where(
            and(
              eq(pullRequest.projectId, project.projectId),
              eq(pullRequest.number, row.pullRequestNumber),
            ),
          ),
    host.members(project.workspaceId),
    dependenciesOf(host.db, project, row.id),
    overlapsOf(host.db, project, row),
    usageOf(host.db, project, row.id),
    taskQuestions(host.db, project, row.id),
    Promise.all([
      host.db.select({ n: count() }).from(taskRevision).where(ofRevisions),
      host.db.select({ n: count() }).from(taskComment).where(ofComments),
      host.db.select({ n: count() }).from(outboxEvent).where(ofEvents),
    ]),
  ]);
  const [[revisionCount], [commentCount], [eventCount]] = counts;
  const rest = (total: { n: number } | undefined, shown: number) =>
    Math.max(0, (total?.n ?? 0) - shown);

  const agentIds = new Set<string>();
  for (const id of [
    row.creatorAgentId,
    ...revisions.map((r) => r.authorAgentId),
    ...events.map((e) => e.actorAgentId),
    ...questions.rows.flatMap(questionAgentIds),
  ]) {
    if (id) agentIds.add(id);
  }
  const agents =
    agentIds.size === 0
      ? []
      : await host.db
          .select({ id: agent.id, name: agent.name })
          .from(agent)
          .where(and(eq(agent.projectId, project.projectId), inArray(agent.id, [...agentIds])));
  const names: Names = {
    members: namesOf(members),
    agents: new Map(agents.map((a) => [a.id, a.name])),
  };

  return {
    ...toTask(found),
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    creator: requiredAuthor(names, row.creatorUserId, row.creatorAgentId),
    revisions: revisions.map(
      (r): Revision => ({
        number: r.number,
        title: r.title,
        description: r.description,
        acceptanceCriteria: r.acceptanceCriteria,
        author: requiredAuthor(names, r.authorUserId, r.authorAgentId),
        createdAt: r.createdAt.toISOString(),
      }),
    ),
    comments: comments.map(
      (c): Comment => ({
        id: c.id,
        author: requiredAuthor(names, c.authorUserId, null),
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      }),
    ),
    revisionsNotShown: rest(revisionCount, revisions.length),
    commentsNotShown: rest(commentCount, comments.length),
    questions: questions.rows.map((q) => toQuestion(q, names)),
    answeredNotShown: questions.answeredNotShown,
    timelineNotShown: rest(eventCount, events.length),
    timeline: events.reverse().map((e): TimelineEvent => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        kind: e.kind,
        actor: authorOf(names, e.actorUserId, e.actorAgentId),
        message: typeof payload.message === "string" ? payload.message : null,
        revision:
          Number.isInteger(payload.revision) && (payload.revision as number) > 0
            ? (payload.revision as number)
            : null,
        createdAt: e.createdAt.toISOString(),
      };
    }),
    pullRequest: pull[0] ? toPullRequest(pull[0]) : null,
    dependencies,
    overlaps: overlaps.slice(0, OVERLAPS_LISTED),
    overlapsNotShown: Math.max(0, overlaps.length - OVERLAPS_LISTED),
    usage,
  };
}

// --- Writes -------------------------------------------------------------------------------------

const NOT_PROJECT_TASK =
  "A task it waits for isn't one of this project's tasks. Pick them from this project's tasks.";

/** The titles of the project's tasks `ids`, by id: one that isn't the project's is refused. */
async function projectTaskTitles(
  tx: DevSyncDb,
  project: ProjectRef,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: task.id, title: task.title })
    .from(task)
    .where(
      and(
        eq(task.projectId, project.projectId),
        eq(task.workspaceId, project.workspaceId),
        inArray(task.id, [...ids]),
      ),
    );
  if (rows.length !== ids.length) {
    throw new DevSyncError("invalid", NOT_PROJECT_TASK, ["dependsOn"]);
  }
  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * Holds the project's dependencies for the rest of `tx` (a transaction-level advisory lock), so
 * two edits made at once can't close a circle that neither sees alone.
 */
async function lockDependencies(tx: DevSyncDb, project: ProjectRef): Promise<void> {
  const key = `devsync.task_dependency:${project.workspaceId}:${project.projectId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Refuses task `taskId` waiting for `dependsOn` (the project's tasks, by `titles`) when one of
 * them waits for it, directly or through other tasks: the project's dependencies are read under
 * `lockDependencies`, without the task's own, which this edit replaces.
 */
async function refuseCircle(
  tx: DevSyncDb,
  project: ProjectRef,
  taskId: string,
  dependsOn: readonly string[],
  titles: Map<string, string>,
): Promise<void> {
  const edges = await tx
    .select({ from: taskDependency.taskId, to: taskDependency.dependsOnTaskId })
    .from(taskDependency)
    .where(eq(taskDependency.projectId, project.projectId));
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (from === taskId) continue;
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }
  for (const start of dependsOn) {
    const seen = new Set<string>();
    const stack = [start];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (at === taskId) {
        throw new DevSyncError(
          "conflict",
          `Task "${titles.get(start) ?? ""}" already waits for this task, so this task can't wait for it. Remove it from the tasks this one waits for.`,
          ["dependsOn"],
        );
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(next.get(at) ?? []));
    }
  }
}

/** Replaces the tasks `taskId` waits for with `dependsOn`, in their order, in `tx`. */
async function writeDependencies(
  tx: DevSyncDb,
  project: ProjectRef,
  taskId: string,
  dependsOn: readonly string[],
): Promise<void> {
  await tx
    .delete(taskDependency)
    .where(and(eq(taskDependency.taskId, taskId), eq(taskDependency.projectId, project.projectId)));
  if (dependsOn.length === 0) return;
  await tx.insert(taskDependency).values(
    dependsOn.map((dependsOnTaskId, position) => ({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      taskId,
      dependsOnTaskId,
      position,
    })),
  );
}

/**
 * The tasks an edit makes task `taskId` (locked) wait for, checked (the project's, never itself,
 * never in a circle), or null when the edit leaves them as they are.
 */
async function editedDependencies(
  tx: DevSyncDb,
  project: ProjectRef,
  taskId: string,
  dependsOn: readonly string[] | undefined,
): Promise<readonly string[] | null> {
  if (dependsOn === undefined) return null;
  const before = await tx
    .select({ id: taskDependency.dependsOnTaskId })
    .from(taskDependency)
    .where(and(eq(taskDependency.taskId, taskId), eq(taskDependency.projectId, project.projectId)))
    .orderBy(asc(taskDependency.position));
  if (dependsOn.length === before.length && dependsOn.every((id, i) => id === before[i]?.id)) {
    return null;
  }
  if (dependsOn.includes(taskId)) {
    throw new DevSyncError(
      "invalid",
      "A task can't wait for itself. Remove it from the tasks it waits for.",
      ["dependsOn"],
    );
  }
  const titles = await projectTaskTitles(tx, project, dependsOn);
  await lockDependencies(tx, project);
  await refuseCircle(tx, project, taskId, dependsOn, titles);
  return dependsOn;
}

/**
 * `POST /tasks` (a member, `TaskInput`) and `create_task` (an agent, `AgentTaskInput`, or a
 * member, who may give a `requestId` too): a task in Backlog with revision 1 of its requirements.
 * A retry by the same creator with the same `requestId` answers the task it created; the same
 * `requestId` with other requirements is refused. A member's task from a security finding keeps the
 * finding's fingerprint, rule and file as the host gives them, read again here (never the
 * browser's copy): a finding the host no longer gives is refused, and so is one with an open linked
 * task (`linkedTask`). The tasks it waits for are the project's; a new task can't close a circle,
 * since none waits for it yet.
 */
export async function createTask(
  host: DevSyncHost,
  actor: TaskActor,
  input: TaskInput | AgentTaskInput,
): Promise<Task> {
  requireWrite(actor);
  const { project } = actor;
  const agentActor = isAgent(actor) ? actor : null;
  const agentId = agentActor?.agentId ?? null;
  const parsed: TaskInput & { requestId?: string } = agentActor
    ? parse(AgentTaskInput, input)
    : parse(MemberTaskInput, input);
  const { requestId = null, finding: from, owns, dependsOn, labels, branch, ...given } = parsed;
  const fields = agentActor ? redactRequirements(host, given) : given;
  const ownFields = fieldsOf({ owns, dependsOn, labels, branch });
  const extra = agentActor ? redactFields(host, ownFields) : ownFields;
  const waitsFor = extra.dependsOn ?? [];
  const finding = from ? await hostFinding(host, project, from.fingerprint) : null;
  const at = host.clock.now();
  const creator = actorIds(actor);

  const result = await host.db.transaction(async (tx) => {
    if (requestId) {
      // One create per agent at a time, so a retry finds what the first attempt saved. A member's
      // two at once under one request id: the database keeps the first, and the second fails.
      if (agentActor) await lockAgentRow(tx, agentActor);
      const [existing] = await selectTasks(
        tx,
        and(
          eq(task.projectId, project.projectId),
          "agentId" in creator
            ? eq(task.creatorAgentId, creator.agentId)
            : eq(task.creatorUserId, creator.userId),
          eq(task.createRequestId, requestId),
        ),
      );
      if (existing) {
        const [original] = await tx
          .select()
          .from(taskRevision)
          .where(and(eq(taskRevision.taskId, existing.task.id), eq(taskRevision.number, 1)));
        if (
          !original ||
          original.title !== fields.title ||
          original.description !== fields.description ||
          original.acceptanceCriteria !== fields.acceptanceCriteria
        ) {
          throw new DevSyncError(
            "conflict",
            "This request ID was already used for another task. Send a new request ID.",
            ["requestId"],
          );
        }
        return { task: toTask(existing), created: false };
      }
    }
    // An agent's new task counts against its 20 a minute; its retry above doesn't.
    if (agentActor) await countTaskWrite(tx, agentActor, at);
    // One open task per finding (R-10); two creates at the same instant may both pass, accepted.
    const linked = finding ? await linkedTask(tx, project, finding) : null;
    if (linked) {
      throw new DevSyncError(
        "conflict",
        `This finding already has a task, "${linked.title}". Open it instead.`,
      );
    }
    await projectTaskTitles(tx, project, waitsFor);
    const [row] = await tx
      .insert(task)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        ...fields,
        owns: extra.owns ?? [],
        labels: extra.labels ?? [],
        branch: extra.branch ?? null,
        creatorUserId: "userId" in creator ? creator.userId : null,
        creatorAgentId: agentId,
        createRequestId: requestId,
        findingFingerprint: finding?.fingerprint ?? null,
        findingRule: finding?.ruleId ?? null,
        findingFile: finding?.file ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!row) throw new Error("The task wasn't saved.");
    await writeDependencies(tx, project, row.id, waitsFor);
    await tx.insert(taskRevision).values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      taskId: row.id,
      number: 1,
      ...fields,
      authorUserId: row.creatorUserId,
      authorAgentId: row.creatorAgentId,
      createdAt: at,
    });
    await outbox.record(host, tx, {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      actor: creator,
      taskId: row.id,
      kind: "task.created",
      payload: {
        taskId: row.id,
        revision: row.revision,
        version: row.version,
        message: `Task created: ${row.title}`,
      },
      at,
      facts: { status: { from: null, to: row.status } },
    });
    return {
      task: toTask({ task: row, claimAgentName: null, dependsOn: [...waitsFor] }),
      created: true,
    };
  });
  if (result.created) await outbox.wake(host, project.projectId);
  return result.task;
}

/**
 * The event a saved edit records, and its plain-English
 * message: none unless the requirements, the status or the assignee changed; then a requirements
 * change, else a Blocked task (whatever else changed), else an assignment, else a move.
 */
function editEvent(before: TaskRow, after: TaskRow, revised: boolean) {
  const reassigned = after.assigneeUserId !== before.assigneeUserId;
  if (revised) return { kind: "requirements.changed", label: "Requirements changed" };
  if (after.status === before.status && !reassigned) return null;
  if (after.status === "BLOCKED") return { kind: "task.blocked", label: "Task blocked" };
  if (reassigned) {
    return {
      kind: "task.assigned",
      label: after.assigneeUserId ? "Task assigned" : "Task unassigned",
    };
  }
  return { kind: "task.updated", label: `Task moved to ${STATUS_LABEL[after.status]}` };
}

/** Whether a claimed task's claim still holds: it hasn't expired and its agent isn't revoked. */
async function claimHolds(tx: DevSyncDb, row: TaskRow, now: Date): Promise<boolean> {
  if (!row.claimAgentId || !row.claimExpiresAt) return false;
  if (row.claimExpiresAt.getTime() <= now.getTime()) return false;
  const [holder] = await tx
    .select({ revokedAt: agent.revokedAt })
    .from(agent)
    .where(and(eq(agent.id, row.claimAgentId), eq(agent.projectId, row.projectId)));
  return holder !== undefined && holder.revokedAt === null;
}

/**
 * `PATCH /tasks/:taskId` (a member, `TaskUpdate`) and `update_task` (an agent, its fields without
 * `taskId`): checks the version read, the lifecycle and a claim's hold on the status; keeps a new
 * revision when the requirements change, and none for its paths, the tasks it waits for, its labels
 * or its branch. A Done or Cancelled task's requirements no longer change (its other fields may). An
 * agent edits only the tasks it created, moves them to Backlog or Ready only, and never assigns
 * them. An assignee is a member of the workspace.
 */
export async function updateTask(
  host: DevSyncHost,
  actor: TaskActor,
  taskId: string,
  input: TaskUpdate | AgentUpdateFields,
): Promise<Task> {
  requireWrite(actor);
  const { project } = actor;
  const agentActor = isAgent(actor) ? actor : null;
  const update: TaskUpdate = agentActor
    ? agentUpdate(host, parse(AgentUpdateFields, input))
    : parse(TaskUpdate, input);
  const { version, status, assigneeUserId } = update;
  const id = taskIdOf(taskId);

  // Checked before the transaction: a removal committing in between (`removeMember`) won't unassign
  // this task, as it only unassigns tasks already assigned. Re-checking after the row lock wouldn't
  // close that window either, since the removal doesn't wait on this row; accepted as is.
  if (assigneeUserId) {
    const members = await host.members(project.workspaceId);
    if (!members.some((m) => m.userId === assigneeUserId)) {
      throw new DevSyncError(
        "invalid",
        "Only a member of this workspace can be assigned a task. Pick one from the list.",
        ["assigneeUserId"],
      );
    }
  }
  const at = host.clock.now();

  const result = await host.db.transaction(async (tx) => {
    // An agent's edit counts against its 20 a minute, its row locked before the task's.
    if (agentActor) await countTaskWrite(tx, agentActor, at);
    // `no key update`, not `update`: a dependency on this task written meanwhile under
    // `lockDependencies` locks it `key share`, and mustn't wait for this edit.
    const [current] = await tx.select().from(task).where(taskIn(project, id)).for("no key update");
    if (!current) throw noSuchTask();
    if (agentActor && current.creatorAgentId !== agentActor.agentId) {
      throw new DevSyncError(
        "forbidden",
        "An agent can change only the tasks it created. Ask a member to change this one.",
      );
    }
    if (version !== current.version) throw new DevSyncError("conflict", TASK_CHANGED);
    // A live claim's task moves only through the claim or by cancelling it; one whose claim expired
    // or whose agent was revoked moves as any other, its claim ended.
    if (
      current.status === "CLAIMED" &&
      status &&
      status !== "CLAIMED" &&
      status !== "CANCELLED" &&
      (await claimHolds(tx, current, at))
    ) {
      throw new DevSyncError(
        "conflict",
        "An agent has claimed this task, so its status changes only through the claim. Wait for the agent to release it or for its claim to expire, or cancel the task.",
      );
    }
    if (status && status !== current.status && !TRANSITIONS[current.status].includes(status)) {
      throw moveRefusal(current.status, status);
    }
    const dependencies = await editedDependencies(tx, project, id, update.dependsOn);
    const fields = {
      title: update.title ?? current.title,
      description: update.description ?? current.description,
      acceptanceCriteria: update.acceptanceCriteria ?? current.acceptanceCriteria,
    };
    const revised =
      fields.title !== current.title ||
      fields.description !== current.description ||
      fields.acceptanceCriteria !== current.acceptanceCriteria;
    // What was asked of a closed task stays the record of it: its requirements no longer change.
    if (revised && CLOSED.includes(current.status)) {
      throw new DevSyncError(
        "conflict",
        `This task is ${STATUS_LABEL[current.status]}, which is final: its requirements stay as they are. Create a new task for further work.`,
      );
    }
    if (revised && current.revision >= REVISION_LIMIT) {
      throw new DevSyncError(
        "conflict",
        `This task has ${REVISION_LIMIT} revisions of its requirements, the most a task keeps. Create a new task for further changes.`,
      );
    }

    const [saved] = await tx
      .update(task)
      .set({
        ...fields,
        ...(status ? { status } : {}),
        ...(assigneeUserId !== undefined ? { assigneeUserId } : {}),
        ...(update.owns !== undefined ? { owns: update.owns } : {}),
        ...(update.labels !== undefined ? { labels: update.labels } : {}),
        ...(update.branch !== undefined ? { branch: update.branch } : {}),
        ...(status && status !== "CLAIMED"
          ? { claimAgentId: null, claimId: null, claimExpiresAt: null }
          : {}),
        // A task leaving Blocked is no longer Blocked by a question's wait.
        ...(status && status !== current.status ? { blockedByQuestion: false } : {}),
        version: current.version + 1,
        revision: revised ? current.revision + 1 : current.revision,
        updatedAt: at,
      })
      .where(and(taskIn(project, id), eq(task.version, version)))
      .returning();
    if (!saved) throw new DevSyncError("conflict", TASK_CHANGED);
    if (dependencies) await writeDependencies(tx, project, id, dependencies);
    // Moved off a question's block: its open questions no longer hold it.
    if (current.blockedByQuestion && saved.status !== current.status) {
      await releaseWaitingQuestions(tx, project, id);
    }

    const author = actorIds(actor);
    if (revised) {
      await tx.insert(taskRevision).values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        taskId: id,
        number: saved.revision,
        ...fields,
        authorUserId: "userId" in author ? author.userId : null,
        authorAgentId: "agentId" in author ? author.agentId : null,
        createdAt: at,
      });
    }
    const event = editEvent(current, saved, revised);
    if (event) {
      // A move off Claimed ends the claim, live (a cancel) or expired, without a review.
      const released = current.claimAgentId && !saved.claimAgentId ? current.claimAgentId : null;
      await outbox.record(host, tx, {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        actor: author,
        taskId: id,
        kind: event.kind,
        payload: {
          taskId: id,
          revision: saved.revision,
          version: saved.version,
          message: `${event.label}: ${saved.title}`,
        },
        at,
        facts: {
          status: { from: current.status, to: saved.status },
          ...(released ? { released } : {}),
          ...(saved.assigneeUserId !== current.assigneeUserId
            ? { assigned: saved.assigneeUserId }
            : {}),
        },
      });
    }
    return { task: await loadTask(tx, project, id), recorded: event !== null };
  });
  if (result.recorded) await outbox.wake(host, project.projectId);
  return result.task;
}

/**
 * `POST /tasks/:taskId/comments`: a member's comment, newest first on the task, which holds 500 at
 * most: they are counted with the task's row locked, so two at once can't both take the last place.
 */
export async function commentOnTask(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
  input: CommentInput,
): Promise<Comment> {
  requireWrite(ctx);
  const { body } = parse(CommentInput, input);
  const { project, member } = ctx;
  const id = taskIdOf(taskId);
  const row = await host.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: task.id })
      .from(task)
      .where(taskIn(project, id))
      .for("no key update");
    if (!found) throw noSuchTask();
    const [held] = await tx
      .select({ n: count() })
      .from(taskComment)
      .where(and(eq(taskComment.taskId, id), eq(taskComment.projectId, project.projectId)));
    if ((held?.n ?? 0) >= COMMENT_LIMIT) {
      throw new DevSyncError(
        "conflict",
        `This task has ${COMMENT_LIMIT} comments, the most a task keeps. Go on in a new task.`,
      );
    }
    const [saved] = await tx
      .insert(taskComment)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        taskId: id,
        authorUserId: member.userId,
        body,
        createdAt: host.clock.now(),
      })
      .returning();
    if (!saved) throw new Error("The comment wasn't saved.");
    await host.audit(
      tx,
      { userId: member.userId },
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        action: "devsync.task.comment_added",
        detail: { taskId: id, commentId: saved.id },
      },
    );
    return saved;
  });
  return {
    id: row.id,
    author: { kind: "member", userId: member.userId, name: member.name },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `PUT /tasks/:taskId/pull-request`: links the task to a pull request DevSync has seen on the
 * project's repository, or unlinks it (`null`). A change is audited.
 */
export async function linkPullRequest(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
  input: PullRequestLink,
): Promise<Task> {
  requireWrite(ctx);
  const { number } = parse(PullRequestLink, input);
  const { project, member } = ctx;
  const id = taskIdOf(taskId);
  const at = host.clock.now();
  return host.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ pullRequestNumber: task.pullRequestNumber, version: task.version })
      .from(task)
      .where(taskIn(project, id))
      .for("update");
    if (!current) throw noSuchTask();
    if (number !== null) {
      const [seen] = await tx
        .select({ id: pullRequest.id })
        .from(pullRequest)
        .where(and(eq(pullRequest.projectId, project.projectId), eq(pullRequest.number, number)));
      if (!seen) {
        throw new DevSyncError(
          "not-found",
          `DevSync hasn't seen pull request #${number} on this project's repository. Check the number, or wait for GitHub to report it.`,
          ["number"],
        );
      }
    }
    if (current.pullRequestNumber !== number) {
      const link = { taskId: id, current, number, at };
      await writePullRequestLink(host, tx, { userId: member.userId }, project, link);
    }
    return loadTask(tx, project, id);
  });
}

/**
 * Links the task to pull request `number` (or unlinks it) in `tx`, the task's row locked and read
 * as `current`: its version bumped, the change audited, and a link emitted (`devsync.pr.linked`).
 * A member's link and a finished run's draft pull request both go through it.
 */
export async function writePullRequestLink(
  host: DevSyncHost,
  tx: DevSyncDb,
  actor: AuditActor,
  project: Pick<ProjectRef, "workspaceId" | "projectId">,
  link: {
    taskId: string;
    current: { pullRequestNumber: number | null; version: number };
    number: number | null;
    at: Date;
  },
): Promise<void> {
  const { taskId, current, number, at } = link;
  await tx
    .update(task)
    .set({ pullRequestNumber: number, version: current.version + 1, updatedAt: at })
    .where(taskIn(project, taskId));
  await host.audit(tx, actor, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    action: "devsync.task.pull_request_linked",
    detail: { taskId, previousNumber: current.pullRequestNumber, number },
  });
  if (number !== null) {
    const { workspaceId, projectId } = project;
    const by = actor === "host" ? null : actor;
    await outbox.emit(host, tx, {
      workspaceId,
      projectId,
      taskId,
      actor: by,
      facts: { linked: number },
    });
  }
}
