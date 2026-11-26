import { z } from "zod";
import {
  Author,
  Counter,
  FindingFingerprint,
  Id,
  LIMITS,
  MAX_PULL_REQUEST,
  Timestamp,
} from "./common";
import { TaskStatus } from "./lifecycle";
import { Question } from "./questions";

const title = z.string().trim().min(1).max(LIMITS.title);
const description = z.string().trim().max(LIMITS.description);
const acceptanceCriteria = z.string().trim().max(LIMITS.acceptanceCriteria);

/** The limits on a task's fields beyond its requirements. */
export const TASK_FIELD_LIMITS = {
  owns: 50,
  path: 400,
  dependsOn: 20,
  labels: 10,
  label: 40,
  branch: 200,
} as const;

/**
 * A path a task may change: POSIX, relative to the repository's root, so no leading `/`, no NUL,
 * and no empty, `.` or `..` segment (each path has one spelling, so two tasks' paths compare). A
 * path ending in `/` is the folder and everything under it.
 */
export function isRepositoryPath(path: string): boolean {
  if (path.includes("\u0000") || path.startsWith("/")) return false;
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The characters git refuses in a ref's name, beyond the control characters. */
const REF_FORBIDDEN = new Set([..." ~^:?*[\\"]);

/**
 * A branch name as git takes one (`git check-ref-format --branch`): no space, control character
 * or any of `~^:?*[\`, no `..`, `//` or `@{`, not starting with `-` or `/`, not ending with `/` or
 * `.`, no part starting with `.` or ending with `.lock`, and neither `@` nor `HEAD`.
 */
export function isBranchName(name: string): boolean {
  if (name === "" || name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || REF_FORBIDDEN.has(char)) return false;
  }
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Whether every value of `list` is there once, compared by `key`. */
function once(list: readonly string[], key: (value: string) => string = (value) => value): boolean {
  return new Set(list.map(key)).size === list.length;
}

/** One of the paths a task may change: `isRepositoryPath`, at most 400 characters. */
export const OwnedPath = z
  .string()
  .trim()
  .min(1)
  .max(TASK_FIELD_LIMITS.path)
  .refine(isRepositoryPath, "Give a path relative to the repository's root.");

/** A task's branch: `isBranchName`, at most 200 characters. */
export const BranchName = z
  .string()
  .trim()
  .min(1)
  .max(TASK_FIELD_LIMITS.branch)
  .refine(isBranchName, "Give a branch name git takes.");

/**
 * A task's fields beyond its requirements: none of them is part of a requirements revision.
 * `owns`: the paths it may change (each once); `dependsOn`: the project's tasks it waits for (each
 * once); `labels`: each once, whatever its case; `branch`: its branch, or null.
 */
export const TaskFields = z.strictObject({
  owns: z
    .array(OwnedPath)
    .max(TASK_FIELD_LIMITS.owns)
    .refine((paths) => once(paths), "Give each path once.")
    .optional(),
  dependsOn: z
    .array(Id)
    .max(TASK_FIELD_LIMITS.dependsOn)
    .refine((ids) => once(ids), "Give each task once.")
    .optional(),
  labels: z
    .array(z.string().trim().min(1).max(TASK_FIELD_LIMITS.label))
    .max(TASK_FIELD_LIMITS.labels)
    .refine((labels) => once(labels, (label) => label.toLowerCase()), "Give each label once.")
    .optional(),
  branch: BranchName.nullable().optional(),
});
export type TaskFields = z.infer<typeof TaskFields>;

/**
 * `POST /tasks`. With `finding`, the task is made from that security finding: the server reads it
 * again from the host, so the browser sends only its fingerprint. The fields left out are empty.
 */
export const TaskInput = z.strictObject({
  title,
  description,
  acceptanceCriteria,
  ...TaskFields.shape,
  finding: z.strictObject({ fingerprint: FindingFingerprint }).optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;

/** `PATCH /tasks/:taskId`: the version read, and any of the fields. */
export const TaskUpdate = z.strictObject({
  version: Counter,
  title: title.optional(),
  description: description.optional(),
  acceptanceCriteria: acceptanceCriteria.optional(),
  status: TaskStatus.optional(),
  assigneeUserId: Id.nullable().optional(),
  ...TaskFields.shape,
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

/** A count of tokens. */
const Tokens = z.number().int().nonnegative();

/**
 * What an agent reports it used since its previous report on the task, with `report_progress` or
 * `request_review`: its own estimate, each figure optional.
 */
export const AgentUsage = z.strictObject({
  inputTokens: Tokens.optional(),
  outputTokens: Tokens.optional(),
  cacheCreationInputTokens: Tokens.optional(),
  cacheReadInputTokens: Tokens.optional(),
  costUsd: z.number().nonnegative().optional(),
  model: z.string().trim().min(1).max(100).optional(),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

/**
 * A sum of usage: the agents' reports on a task (their own estimates), or its managed runs'.
 * `count` is how many reports or runs it adds up; `models` the models they named, each once.
 */
export const UsageTotal = z.object({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheCreationInputTokens: Tokens,
  cacheReadInputTokens: Tokens,
  costUsd: z.number().nonnegative(),
  models: z.array(z.string()),
  count: z.number().int().positive(),
});
export type UsageTotal = z.infer<typeof UsageTotal>;

/** `POST /tasks/:taskId/comments`. */
export const CommentInput = z.strictObject({
  body: z.string().trim().min(1).max(LIMITS.comment),
});
export type CommentInput = z.infer<typeof CommentInput>;

/** `PUT /tasks/:taskId/pull-request`: a pull request's number, or null to unlink it. */
export const PullRequestLink = z.strictObject({
  number: z.number().int().positive().max(MAX_PULL_REQUEST).nullable(),
});
export type PullRequestLink = z.infer<typeof PullRequestLink>;

/** `GET /tasks`' query: `assignee` is `me`, `none` or a user id. */
export const TaskListQuery = z.strictObject({
  status: TaskStatus.optional(),
  assignee: z.union([z.literal("me"), z.literal("none"), Id]).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** The workspace's `GET /tasks` query; without `status`, the open tasks. */
export const WorkspaceTaskListQuery = TaskListQuery.extend({ project: Id.optional() });
export type WorkspaceTaskListQuery = z.infer<typeof WorkspaceTaskListQuery>;

/** A task, as lists and changes answer it. */
export const Task = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  status: TaskStatus,
  revision: Counter,
  version: Counter,
  assigneeUserId: Id.nullable(),
  claim: z.object({ agentId: Id, agentName: z.string(), expiresAt: Timestamp }).nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  /** The paths it may change; one ending in `/` is a folder. */
  owns: z.array(z.string()),
  /** The project's tasks it waits for, in the order given. */
  dependsOn: z.array(Id),
  labels: z.array(z.string()),
  branch: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** Another task, named: one this task waits for, or one whose paths overlap its own. */
export const TaskSummary = z.object({ id: Id, title: z.string(), status: TaskStatus });
export type TaskSummary = z.infer<typeof TaskSummary>;

/** `GET /tasks` (project route). */
export const TaskList = z.object({ tasks: z.array(Task) });
export type TaskList = z.infer<typeof TaskList>;

/** A task on the workspace's list, with its project's name. */
export const WorkspaceTask = Task.extend({ projectName: z.string() });
export type WorkspaceTask = z.infer<typeof WorkspaceTask>;

/** `GET /tasks` (workspace route). */
export const WorkspaceTaskList = z.object({ tasks: z.array(WorkspaceTask) });
export type WorkspaceTaskList = z.infer<typeof WorkspaceTaskList>;

/** A pull request as DevSync last saw it. */
export const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  url: z.url(),
  updatedAt: Timestamp,
});
export type PullRequest = z.infer<typeof PullRequest>;

/** `GET /pull-requests`: the 50 most recently updated. */
export const PullRequestList = z.object({ pullRequests: z.array(PullRequest) });
export type PullRequestList = z.infer<typeof PullRequestList>;

/** A comment on a task: `POST /tasks/:taskId/comments`' answer. */
export const Comment = z.object({ id: Id, author: Author, body: z.string(), createdAt: Timestamp });
export type Comment = z.infer<typeof Comment>;

/** One revision of a task's requirements. */
export const Revision = z.object({
  number: Counter,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  author: Author,
  createdAt: Timestamp,
});
export type Revision = z.infer<typeof Revision>;

/** One event on a task's timeline; `actor` is null for what the host did (GitHub's facts). */
export const TimelineEvent = z.object({
  id: Id,
  kind: z.string(),
  actor: Author.nullable(),
  message: z.string().nullable(),
  revision: Counter.nullable(),
  createdAt: Timestamp,
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

/**
 * `GET /tasks/:taskId`: revisions and comments newest first, the timeline oldest first. Beyond the
 * `Task`: the tasks it waits for (`dependencies`, in its `dependsOn` order: one not Done or
 * Cancelled keeps it from being claimed); while it is open, the other open tasks whose paths
 * overlap its own, each with the paths they share (`overlaps`); the usage its agents reported
 * beside its managed runs', kept apart (`usage`, each null when there is none); and its questions,
 * the open ones first, each group oldest first (`questions`).
 */
export const TaskDetail = Task.extend({
  description: z.string(),
  acceptanceCriteria: z.string(),
  creator: Author,
  revisions: z.array(Revision),
  comments: z.array(Comment),
  questions: z.array(Question),
  timeline: z.array(TimelineEvent),
  pullRequest: PullRequest.nullable(),
  dependencies: z.array(TaskSummary),
  overlaps: z.array(z.object({ task: TaskSummary, paths: z.array(z.string()) })),
  usage: z.object({ agents: UsageTotal.nullable(), runs: UsageTotal.nullable() }),
});
export type TaskDetail = z.infer<typeof TaskDetail>;
