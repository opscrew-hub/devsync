/**
 * Recording outbox events in the change's transaction. An outbox event is delivered to the
 * project's agents by the `devsync.outbox` queue (`deliverDue`), and the task's events are its
 * timeline. A domain function records its event with `outbox.record(tx, event)` inside its
 * transaction, then calls `outbox.wake(host, projectId)` once: the host runs the queue after the
 * commit, and never if the change rolls back.
 */
import { type OutboxEventRow, outboxEvent } from "../db";
import type { DevSyncDb, DevSyncHost } from "../host";

/** Who caused an event: a member, an agent, or the host (a GitHub fact). */
export type OutboxActor = { userId: string } | { agentId: string } | null;

/** An event to record: a task's change has the payload `{ taskId, revision, version, message }`. */
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
  /** `host.clock.now()`: the event's time, and when it is first due. */
  at: Date;
}

/** Inserts the event in `tx`, the transaction making the change, due at once. */
async function recordOutboxEvent(tx: DevSyncDb, event: OutboxRecord): Promise<OutboxEventRow> {
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
      createdAt: event.at,
      availableAt: event.at,
    })
    .returning();
  if (!row) throw new Error("The outbox event wasn't recorded.");
  return row;
}

/** Asks the host to run `devsync.outbox` for the project: once per change that recorded an event. */
function wakeOutbox(host: DevSyncHost, projectId: string): Promise<void> {
  return host.enqueue("devsync.outbox", { projectId });
}

/** The outbox: `record` in the change's transaction, `wake` once after it. */
export const outbox = { record: recordOutboxEvent, wake: wakeOutbox } as const;
