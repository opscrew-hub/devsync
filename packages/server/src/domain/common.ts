/**
 * What the domain files share: parsing an input, the role and read-only checks, the agent-row lock,
 * an agent's signal limit, finding a task of the project, reading a security finding from the host,
 * naming members and agents, and the refusals more than one of them gives. Internal to the server:
 * the package's index doesn't export it.
 */
import {
  type Action,
  type Author,
  can,
  Finding,
  Id,
  type Role,
  SignalKind,
} from "@devsync/schemas";
import { and, count, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { agent, question, signal, task } from "../db";
import {
  type AgentActor,
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type Member,
  type ProjectRef,
} from "../host";

/** The refusals' texts, plain English, each saying what to do next. */
export const REFUSAL = {
  unauthenticated: "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.",
  devSyncOff: "DevSync is off for this project. Ask an Owner or Admin to switch it on.",
  readOnly:
    "This project is read-only because its workspace is past its plan. Ask an Owner to upgrade the plan.",
  claimNotActive:
    "This claim is no longer active: it expired, was released or ended with a report. Claim the task again if it is Ready.",
  /** A task not found, told to a member (and an agent editing one). */
  noSuchTask: "There's no such task in this project.",
  /** A task not found, told to an agent claiming it or reporting on it. */
  noSuchTaskForAgent: "There's no such task in this project. Check its id with get_project_state.",
  /** A message's recipient not found, told to a member. */
  noSuchRecipient:
    "There's no such agent in this project, or it was revoked. Reload the agents list.",
  /** A signal's recipient not found, told to an agent. */
  noSuchPeer:
    "There's no such agent in this project, or it was revoked. Check the agent's id with get_project_state.",
  noSuchSignal: "There's no such signal in your inbox. Check its id with get_pending_signals.",
  /** A security finding the host doesn't give: resolved, another project's, or DevSync off. */
  noSuchFinding:
    "This finding is resolved or isn't this project's. Open it again from the project's security findings.",
} as const;

/** What a member whose role may not do an action is told: by the routes and by the domain. */
const ROLE_REFUSAL: Record<Action, string> = {
  "task.write":
    "Your role can't change this project's tasks. Ask an Owner or Admin for a role that can.",
  "run.request": "Your role can't ask for managed runs. Ask an Owner or Admin for a role that can.",
  "run.decide": "Only an Owner, Admin or Approver can approve or reject a run. Ask one of them.",
};

/**
 * Parses `input` with `schema`, refusing it as `invalid` with the fields' names (an unknown field
 * by its own name), never their values.
 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [
    ...new Set(
      result.error.issues.flatMap((issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => [...issue.path, key].join("."))
          : [issue.path.join(".") || "body"],
      ),
    ),
  ];
  throw new DevSyncError(
    "invalid",
    `Check ${fields.length === 1 ? "this field" : "these fields"} and try again: ${fields.join(", ")}.`,
    fields,
  );
}

/** Refuses a member whose role may not do `action`. */
export function requireRole(role: Role, action: Action): void {
  if (!can(role, action)) throw new DevSyncError("forbidden", ROLE_REFUSAL[action]);
}

/** Refuses a write to a read-only project (past its workspace's plan), a member's or an agent's. */
export function requireWritable(project: ProjectRef): void {
  if (project.readOnly) throw new DevSyncError("forbidden", REFUSAL.readOnly);
}

/**
 * Locks the agent's row in `tx` (`FOR NO KEY UPDATE`), so one agent's idempotent writes and its
 * signal limits are checked one at a time.
 */
export async function lockAgentRow(tx: DevSyncDb, actor: AgentActor): Promise<void> {
  const [row] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, actor.agentId), eq(agent.projectId, actor.project.projectId)))
    .for("no key update");
  if (!row) throw new DevSyncError("unauthenticated", REFUSAL.unauthenticated);
}

export function noSuchTask(): DevSyncError {
  return new DevSyncError("not-found", REFUSAL.noSuchTask);
}

/** A task id from a path or a tool: anything but a UUID is no task of the project's. */
export function taskIdOf(taskId: string): string {
  if (!Id.safeParse(taskId).success) throw noSuchTask();
  return taskId;
}

/** The task `taskId` of the project. */
export function taskIn(
  project: Pick<ProjectRef, "workspaceId" | "projectId">,
  taskId: string,
): SQL {
  return and(
    eq(task.id, taskId),
    eq(task.projectId, project.projectId),
    eq(task.workspaceId, project.workspaceId),
  ) as SQL;
}

/**
 * The project's open security finding `fingerprint` (already checked against its character set),
 * as the host gives it and parsed: refused `not-found` when the host has none. An answer that
 * isn't a finding, or names another fingerprint, is the host's fault: it fails as unexpected, its
 * message naming fields only, never their text.
 */
export async function hostFinding(
  host: DevSyncHost,
  project: ProjectRef,
  fingerprint: string,
): Promise<Finding> {
  const answer = await host.finding(project.projectId, fingerprint);
  if (answer === null) throw new DevSyncError("not-found", REFUSAL.noSuchFinding);
  const parsed = Finding.safeParse(answer);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new Error(`The host's finding doesn't match DevSync's schema at ${paths.join(", ")}.`);
  }
  if (parsed.data.fingerprint !== fingerprint) {
    throw new Error("The host answered another finding than the one DevSync asked for.");
  }
  return parsed.data;
}

/** The name shown for a member who has left the workspace. */
const FORMER_MEMBER = "Former member";

/** The workspace's members' names, by user id. */
export function namesOf(members: Member[]): Map<string, string> {
  return new Map(members.map((m) => [m.userId, m.name]));
}

/** A member as an author or actor, by `names`; one who has left is "Former member". */
export function memberAuthor(
  names: Map<string, string>,
  userId: string,
): Extract<Author, { kind: "member" }> {
  return { kind: "member", userId, name: names.get(userId) ?? FORMER_MEMBER };
}

/** The name shown for an agent whose row is gone. */
export const REMOVED_AGENT = "Removed agent";

/** Members' names by user id, agents' by agent id. */
export interface Names {
  members: Map<string, string>;
  agents: Map<string, string>;
}

/** A member or an agent as an author, by `names`; null for neither (the host's GitHub facts). */
export function authorOf(
  names: Names,
  userId: string | null,
  agentId: string | null,
): Author | null {
  if (userId) return memberAuthor(names.members, userId);
  if (agentId) return { kind: "agent", agentId, name: names.agents.get(agentId) ?? REMOVED_AGENT };
  return null;
}

/** How many signals an agent may send in a minute. */
const SIGNALS_PER_MINUTE = 20;

/**
 * Refuses an agent that sent 20 signals, questions and answers in the last minute, the most it
 * may, in `tx` holding its row: what it published (the kinds publish_signal allows, with its payload
 * `{ message }`), and each question it asked and answer it gave, whether or not it signalled anyone.
 * The signals a question or an answer sends, and the outbox's deliveries of the agent's reports (a
 * review request's too), carry their task and don't count again.
 */
export async function requireSignalRate(
  tx: DevSyncDb,
  actor: AgentActor,
  now: Date,
): Promise<void> {
  const { projectId } = actor.project;
  const since = new Date(now.getTime() - 60_000);
  const [published] = await tx
    .select({ sent: count() })
    .from(signal)
    .where(
      and(
        eq(signal.projectId, projectId),
        eq(signal.senderAgentId, actor.agentId),
        inArray(signal.kind, SignalKind.options),
        sql`${signal.payload} -> 'taskId' is null`,
        gte(signal.createdAt, since),
      ),
    );
  const [asked] = await tx
    .select({ sent: count() })
    .from(question)
    .where(
      and(
        eq(question.projectId, projectId),
        eq(question.askerAgentId, actor.agentId),
        gte(question.createdAt, since),
      ),
    );
  const [answered] = await tx
    .select({ sent: count() })
    .from(question)
    .where(
      and(
        eq(question.projectId, projectId),
        eq(question.answererAgentId, actor.agentId),
        gte(question.answeredAt, since),
      ),
    );
  const sent = (published?.sent ?? 0) + (asked?.sent ?? 0) + (answered?.sent ?? 0);
  if (sent >= SIGNALS_PER_MINUTE) {
    throw new DevSyncError(
      "rate-limited",
      `You sent ${SIGNALS_PER_MINUTE} signals, questions and answers in the last minute, the most an agent may. Wait a minute and try again.`,
    );
  }
}
