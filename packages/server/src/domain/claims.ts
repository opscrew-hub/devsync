/**
 * Task claims (docs/host.md, MCP for coding agents). An agent claims a Ready task (or one whose
 * claim expired) under a claim id of its own for 15 minutes, renews it while it works, and releases
 * it to Ready. Each change is one conditional UPDATE, so two agents never hold the same task; a
 * claim and a release emit their host events (`outbox.emit`) in its transaction. A task is claimed
 * only once the tasks it waits for are Done or Cancelled, and an agent holds at most 3 live claims:
 * its claims are made one at a time (its row locked), so two at once can't both take the third.
 */
import { TaskClaimInput, type TaskStatus } from "@devsync/schemas";
import { and, asc, count, eq, gt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { task, taskDependency } from "../db";
import { type AgentActor, type DevSyncDb, DevSyncError, type DevSyncHost } from "../host";
import { lockAgentRow, parse, REFUSAL, requireWritable } from "./common";
import { outbox } from "./outbox";

/** How long a claim lasts from its claim or renewal. */
const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** The most live claims an agent holds at once. */
const CLAIM_LIMIT = 3;

/** A claim: `claim_task` and `renew_task_claim`'s answer, with the requirements' revision. */
export interface TaskLease {
  id: string;
  status: TaskStatus;
  revision: number;
  version: number;
  claimId: string;
  claimExpiresAt: string;
}

const leaseColumns = {
  id: task.id,
  status: task.status,
  revision: task.revision,
  version: task.version,
  claimId: task.claimId,
  claimExpiresAt: task.claimExpiresAt,
};

type LeaseRow = {
  id: string;
  status: TaskStatus;
  revision: number;
  version: number;
  claimId: string | null;
  claimExpiresAt: Date | null;
};

function toLease(row: LeaseRow): TaskLease {
  if (!row.claimId || !row.claimExpiresAt) throw new Error("A claimed task has no claim.");
  return { ...row, claimId: row.claimId, claimExpiresAt: row.claimExpiresAt.toISOString() };
}

/** How many live claims the agent holds on the project's tasks other than `taskId`. */
async function otherClaims(
  tx: DevSyncDb,
  actor: AgentActor,
  taskId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ held: count() })
    .from(task)
    .where(
      and(
        eq(task.projectId, actor.project.projectId),
        eq(task.status, "CLAIMED"),
        eq(task.claimAgentId, actor.agentId),
        gt(task.claimExpiresAt, now),
        ne(task.id, taskId),
      ),
    );
  return row?.held ?? 0;
}

/**
 * Refuses a claim of `taskId` while a task it waits for is open (neither Done nor Cancelled),
 * naming the first in its order, and while the agent already holds 3 other live claims.
 */
async function requireClaimable(
  tx: DevSyncDb,
  actor: AgentActor,
  taskId: string,
  now: Date,
): Promise<void> {
  const [waiting] = await tx
    .select({ title: task.title })
    .from(taskDependency)
    .innerJoin(
      task,
      and(
        eq(task.id, taskDependency.dependsOnTaskId),
        eq(task.projectId, taskDependency.projectId),
      ),
    )
    .where(
      and(
        eq(taskDependency.taskId, taskId),
        eq(taskDependency.projectId, actor.project.projectId),
        notInArray(task.status, ["DONE", "CANCELLED"]),
      ),
    )
    .orderBy(asc(taskDependency.position))
    .limit(1);
  if (waiting) {
    throw new DevSyncError(
      "conflict",
      `This task waits for task "${waiting.title}". Claim it once that is done.`,
    );
  }
  if ((await otherClaims(tx, actor, taskId, now)) >= CLAIM_LIMIT) {
    throw new DevSyncError(
      "conflict",
      `You hold ${CLAIM_LIMIT} claimed tasks. Release, finish or report a blocker on one before claiming another.`,
    );
  }
}

/** The task, in the agent's project, held by this agent under this claim id and not expired. */
function heldBy(actor: AgentActor, input: TaskClaimInput, now: Date) {
  return and(
    eq(task.id, input.taskId),
    eq(task.projectId, actor.project.projectId),
    eq(task.status, "CLAIMED"),
    eq(task.claimAgentId, actor.agentId),
    eq(task.claimId, input.claimId),
    gt(task.claimExpiresAt, now),
  );
}

/**
 * `claim_task`: claims a Ready task, or one whose claim expired under another claim id, for 15
 * minutes, once the tasks it waits for are done and while the agent holds fewer than 3 other live
 * claims (a takeover of an expired claim counts as a claim). Claiming again under the same live
 * claim answers the same lease.
 */
export async function claimTask(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<TaskLease> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  const lease = await host.db.transaction(async (tx) => {
    // The agent's claims one at a time, so its count of live claims holds until this one commits.
    await lockAgentRow(tx, actor);
    // Read first, locked, for the events: the status it leaves and an expired claim it ends.
    const [before] = await tx
      .select({
        status: task.status,
        claimAgentId: task.claimAgentId,
        claimId: task.claimId,
        claimExpiresAt: task.claimExpiresAt,
      })
      .from(task)
      .where(and(eq(task.id, fields.taskId), eq(task.projectId, actor.project.projectId)))
      .for("update");
    // Only a claim that would take the task is checked: a retry of a live claim isn't a new one.
    const takes =
      before !== undefined &&
      (before.status === "READY" ||
        (before.status === "CLAIMED" &&
          before.claimId !== fields.claimId &&
          before.claimExpiresAt !== null &&
          before.claimExpiresAt.getTime() <= now.getTime()));
    if (takes) await requireClaimable(tx, actor, fields.taskId, now);
    const [claimed] = await tx
      .update(task)
      .set({
        status: "CLAIMED",
        claimAgentId: actor.agentId,
        claimId: fields.claimId,
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        version: sql`${task.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(task.id, fields.taskId),
          eq(task.projectId, actor.project.projectId),
          or(
            eq(task.status, "READY"),
            and(
              eq(task.status, "CLAIMED"),
              ne(task.claimId, fields.claimId),
              lte(task.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .returning(leaseColumns);
    if (claimed && before) {
      await outbox.emit(host, tx, {
        ...scopeOf(actor),
        taskId: claimed.id,
        facts: {
          status: { from: before.status, to: "CLAIMED" },
          claimed: actor.agentId,
          ...(before.claimAgentId ? { released: before.claimAgentId } : {}),
        },
      });
    }
    return claimed;
  });
  if (lease) return toLease(lease);

  const [held] = await host.db
    .select(leaseColumns)
    .from(task)
    .where(heldBy(actor, fields, now));
  if (held) return toLease(held);
  const [found] = await host.db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.id, fields.taskId), eq(task.projectId, actor.project.projectId)));
  if (!found) {
    throw new DevSyncError("not-found", REFUSAL.noSuchTaskForAgent);
  }
  throw new DevSyncError(
    "conflict",
    "This task isn't available to claim: it isn't Ready, or another agent holds it. Pick another Ready task, or try again after its claim expires.",
  );
}

/**
 * `renew_task_claim`: 15 more minutes from now; answers the current requirements' revision. Only
 * new claims count against the limit: claims from before it run out on their own.
 */
export async function renewTaskClaim(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<TaskLease> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  const [lease] = await host.db
    .update(task)
    .set({ claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
    .where(heldBy(actor, fields, now))
    .returning(leaseColumns);
  if (!lease) throw new DevSyncError("conflict", REFUSAL.claimNotActive);
  return toLease(lease);
}

/** `release_task`: ends the claim and returns the task to Ready. */
export async function releaseTask(
  host: DevSyncHost,
  actor: AgentActor,
  input: TaskClaimInput,
): Promise<{ id: string; status: TaskStatus }> {
  requireWritable(actor.project);
  const fields = parse(TaskClaimInput, input);
  const now = host.clock.now();
  return host.db.transaction(async (tx) => {
    const [row] = await tx
      .update(task)
      .set({
        status: "READY",
        claimAgentId: null,
        claimId: null,
        claimExpiresAt: null,
        version: sql`${task.version} + 1`,
        updatedAt: now,
      })
      .where(heldBy(actor, fields, now))
      .returning({ id: task.id, status: task.status });
    if (!row) throw new DevSyncError("conflict", REFUSAL.claimNotActive);
    await outbox.emit(host, tx, {
      ...scopeOf(actor),
      taskId: row.id,
      facts: { status: { from: "CLAIMED", to: row.status }, released: actor.agentId },
    });
    return row;
  });
}

/** The agent's project's ids, which its events name. */
function scopeOf(actor: AgentActor) {
  return { workspaceId: actor.project.workspaceId, projectId: actor.project.projectId };
}
