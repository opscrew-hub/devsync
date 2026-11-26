/**
 * Recording outbox events in the change's transaction. An outbox event is delivered to the
 * project's agents by the `devsync.outbox` queue (`deliverDue`), and the task's events are its
 * timeline. A domain function records its event with `outbox.record(host, tx, event)` inside its
 * transaction, then calls `outbox.wake(host, projectId)` once: the host runs the queue after the
 * commit, and never if the change rolls back.
 *
 * The same record emits DevSync's host events (docs/platform.md, Events) with `host.emit`, and
 * writes its entries in the host's audit log with `host.audit`, in the same transaction:
 * `hostEvents` and `auditEntries` map a timeline kind and its record's facts to them, the one
 * place they are made. A change with no timeline event (a claim, a release, a pull request linked or
 * merged) emits its own with `outbox.emit`, through the same mappings.
 */
import type { AgentUsage, RunFailure, TaskStatus } from "@devsync/schemas";
import { type OutboxEventRow, outboxEvent, type RunRow } from "../db";
import type {
  AuditActor,
  AuditEntry,
  DevSyncDb,
  DevSyncEvent,
  DevSyncHost,
  EventData,
} from "../host";

/** Who caused an event: a member, an agent, or the host (a GitHub fact). */
export type OutboxActor = { userId: string } | { agentId: string } | null;

/**
 * What a change tells the host's events beyond its record's kind and ids: names and ids only,
 * never a title, a description or a message.
 */
export interface EventFacts {
  /** The task's status before the change (null for a new task) and after it. */
  status?: { from: TaskStatus | null; to: TaskStatus };
  /** The agent whose claim on the task the change started. */
  claimed?: string;
  /** The agent whose claim on the task the change ended without a review request. */
  released?: string;
  /** The member the change assigned the task to, or null when it unassigned it. */
  assigned?: string | null;
  /** The pull request the change linked to the task. */
  linked?: number;
  /** The task's pull request, which GitHub merged. */
  merged?: number;
  /** An ended run's status and failure. */
  run?: { status: RunRow["status"]; failure: RunFailure | null };
}

/**
 * An event to record: a task's change has the payload `{ taskId, revision, version, message }`, a
 * question's `{ taskId, questionId, message }`.
 */
export interface OutboxRecord {
  workspaceId: string;
  projectId: string;
  actor: OutboxActor;
  /** The task whose timeline shows the event, if any. */
  taskId?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  /** An agent's report's `requestId`, so a retry records nothing more. */
  requestId?: string | null;
  /** A review decision's review request. */
  reviewRequestId?: string | null;
  /** What an agent reported it used with this report, kept apart from the payload peers receive. */
  usage?: AgentUsage | null;
  /** `host.clock.now()`: the event's time, and when it is first due. */
  at: Date;
  /** What its host events carry beyond the record's ids. */
  facts?: EventFacts;
}

/** A change with host events but no timeline event: its task, who made it and what it did. */
export interface EventChange {
  workspaceId: string;
  projectId: string;
  taskId: string;
  actor: OutboxActor;
  facts: EventFacts;
}

/** What the mappings read of a change: an `OutboxRecord`, or an `EventChange` (no kind). */
type Change = Pick<OutboxRecord, "workspaceId" | "projectId" | "taskId" | "facts" | "actor"> &
  Partial<Pick<OutboxRecord, "kind" | "reviewRequestId" | "payload">>;

/** A host event before the project's ids are added. */
type HostEvent = Pick<DevSyncEvent, "type" | "data">;

/** `value`, which a change of its kind always has: its absence is DevSync's own bug. */
function required<T>(change: Change, value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`A ${change.kind} event has no ${what}.`);
  }
  return value;
}

/** An id or a figure the domain put in the record's payload for its host event. */
function payloadId(change: Change, key: string): string | number {
  const value = change.payload?.[key];
  return required(
    change,
    typeof value === "string" || typeof value === "number" ? value : null,
    key,
  );
}

/**
 * The host's events of a change (docs/platform.md, Events): its timeline kind's, if it has one,
 * then its facts'. Every event names its task; a record with no task has none.
 */
function hostEvents(change: Change): HostEvent[] {
  const { taskId, facts = {} } = change;
  if (!taskId) return [];
  const events: HostEvent[] = [];
  const add = (type: DevSyncEvent["type"], data: EventData = {}) =>
    events.push({ type, data: { taskId, ...data } });
  switch (change.kind) {
    case "task.created":
      add("devsync.task.created", { status: required(change, facts.status, "status").to });
      break;
    case "requirements.changed":
      add("devsync.task.updated", { revision: payloadId(change, "revision") });
      break;
    case "review.requested": {
      const { actor } = change;
      const agentId = actor && "agentId" in actor ? actor.agentId : null;
      add("devsync.review.requested", { agentId: required(change, agentId, "agent") });
      break;
    }
    case "review.approved":
    case "review.changes_requested":
      add(`devsync.${change.kind}`, {
        reviewRequestId: required(change, change.reviewRequestId, "review request"),
      });
      break;
    case "question.asked":
    case "question.answered":
      add(`devsync.${change.kind}`, { questionId: payloadId(change, "questionId") });
      break;
    case "run.finished":
      add("devsync.run.finished", {
        runId: payloadId(change, "runId"),
        ...required(change, facts.run, "ending"),
      });
      break;
  }
  if (facts.released) add("devsync.task.released", { agentId: facts.released });
  const { status } = facts;
  if (status?.from && status.from !== status.to) {
    add("devsync.task.moved", { from: status.from, to: status.to });
    if (status.to === "DONE") add("devsync.task.done");
  }
  if (facts.claimed) add("devsync.task.claimed", { agentId: facts.claimed });
  if (facts.linked !== undefined) add("devsync.pr.linked", { number: facts.linked });
  if (facts.merged !== undefined) add("devsync.pr.merged", { number: facts.merged });
  return events;
}

/** An audit entry before the project's ids are added, with who made the change. */
type HostAudit = { actor: AuditActor } & Pick<AuditEntry, "action" | "detail">;

/**
 * The change's entries in the host's audit log (docs/host.md, Audit): a task created, its
 * requirements changed, a question asked or answered, an assignment, a move of its status, and an
 * agent's own claim starting or ending, each with names and ids only, never a text. A member's are
 * theirs (`{ userId }`); an agent's and the queues' are the host's, an agent's with its id in the
 * detail. A claim another's change ended (a member's cancel, a takeover of an expired claim) is in
 * that change's own entry, the move or the new claim.
 */
function auditEntries(change: Change): HostAudit[] {
  const { taskId, facts = {}, actor } = change;
  if (!taskId) return [];
  const agentId = actor && "agentId" in actor ? actor.agentId : null;
  const by: AuditActor = actor && "userId" in actor ? { userId: actor.userId } : "host";
  const entries: HostAudit[] = [];
  const add = (action: AuditEntry["action"], detail: AuditEntry["detail"] = {}) =>
    entries.push({
      actor: by,
      action,
      detail: { taskId, ...detail, ...(agentId ? { agentId } : {}) },
    });
  switch (change.kind) {
    case "task.created":
      add("devsync.task.created", { status: required(change, facts.status, "status").to });
      break;
    case "requirements.changed":
      add("devsync.task.requirements_changed", { revision: payloadId(change, "revision") });
      break;
    case "question.asked":
    case "question.answered":
      add(`devsync.${change.kind}`, { questionId: payloadId(change, "questionId") });
      break;
  }
  if (facts.released && facts.released === agentId) add("devsync.task.released");
  const { status } = facts;
  if (status?.from && status.from !== status.to) {
    add("devsync.task.moved", { from: status.from, to: status.to });
  }
  if (facts.claimed && facts.claimed === agentId) add("devsync.task.claimed");
  if (facts.assigned !== undefined)
    add("devsync.task.assigned", { assigneeUserId: facts.assigned });
  return entries;
}

/** Emits the change's host events and writes its audit entries in `tx`, the transaction making it. */
async function emitEvents(host: DevSyncHost, tx: DevSyncDb, change: Change): Promise<void> {
  const { workspaceId, projectId } = change;
  for (const event of hostEvents(change)) {
    await host.emit(tx, { workspaceId, projectId, ...event });
  }
  for (const { actor, ...entry } of auditEntries(change)) {
    await host.audit(tx, actor, { workspaceId, projectId, ...entry });
  }
}

/** Inserts the event in `tx`, the change's transaction, due at once, and emits its host events. */
async function recordOutboxEvent(
  host: DevSyncHost,
  tx: DevSyncDb,
  event: OutboxRecord,
): Promise<OutboxEventRow> {
  const actor = event.actor;
  const [row] = await tx
    .insert(outboxEvent)
    .values({
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      actorUserId: actor && "userId" in actor ? actor.userId : null,
      actorAgentId: actor && "agentId" in actor ? actor.agentId : null,
      taskId: event.taskId ?? null,
      requestId: event.requestId ?? null,
      reviewRequestId: event.reviewRequestId ?? null,
      kind: event.kind,
      payload: event.payload,
      usage: event.usage ?? null,
      createdAt: event.at,
      availableAt: event.at,
    })
    .returning();
  if (!row) throw new Error("The outbox event wasn't recorded.");
  await emitEvents(host, tx, event);
  return row;
}

/** Asks the host to run `devsync.outbox` for the project: once per change that recorded an event. */
function wakeOutbox(host: DevSyncHost, projectId: string): Promise<void> {
  return host.enqueue("devsync.outbox", { projectId });
}

/**
 * The outbox: `record` in the change's transaction, `wake` once after it; `emit`, in its
 * transaction, the host events and audit entries of a change with no timeline event.
 */
export const outbox = {
  record: recordOutboxEvent,
  wake: wakeOutbox,
  emit: (host: DevSyncHost, tx: DevSyncDb, change: EventChange) => emitEvents(host, tx, change),
} as const;
