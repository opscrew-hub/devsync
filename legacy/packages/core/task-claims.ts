import { db } from "@devsync/db";
import { DomainError } from "./index.ts";
import { authenticateAgent } from "./agent-signals.ts";

const leaseSeconds = 15 * 60;
type Lease = { id: string; status: string; revision: number; version: number; claimId: string; claimExpiresAt: Date };

export async function claimTask(token: string, taskId: string, claimId: string) {
  const { id: agentId, projectId } = await authenticateAgent(token);
  const [lease] = await db.$queryRaw<Lease[]>`
    UPDATE "Task"
    SET "status" = 'CLAIMED', "claimAgentId" = ${agentId}, "claimId" = ${claimId},
        "claimExpiresAt" = timezone('UTC', clock_timestamp()) + make_interval(secs => ${leaseSeconds}::double precision),
        "version" = "version" + 1, "updatedAt" = timezone('UTC', clock_timestamp())
    WHERE "id" = ${taskId} AND "projectId" = ${projectId}
      AND ("status" = 'READY' OR (
        "status" = 'CLAIMED' AND "claimId" <> ${claimId} AND "claimExpiresAt" <= timezone('UTC', clock_timestamp())
      ))
    RETURNING "id", "status", "revision", "version", "claimId", "claimExpiresAt"
  `;
  if (lease) return lease;
  const task = await db.task.findUnique({
    where: { id: taskId, projectId },
    select: { id: true, status: true, revision: true, version: true, claimId: true, claimExpiresAt: true, claimAgentId: true },
  });
  if (!task) throw new DomainError(404, "Task not found.");
  if (task.status === "CLAIMED" && task.claimAgentId === agentId && task.claimId === claimId &&
      task.claimExpiresAt && task.claimExpiresAt.getTime() > Date.now()) {
    return { id: task.id, status: task.status, revision: task.revision, version: task.version, claimId, claimExpiresAt: task.claimExpiresAt };
  }
  throw new DomainError(409, "Task is not available to claim.");
}

export async function renewTaskClaim(token: string, taskId: string, claimId: string) {
  const { id: agentId, projectId } = await authenticateAgent(token);
  const [lease] = await db.$queryRaw<Lease[]>`
    UPDATE "Task"
    SET "claimExpiresAt" = timezone('UTC', clock_timestamp()) + make_interval(secs => ${leaseSeconds}::double precision)
    WHERE "id" = ${taskId} AND "projectId" = ${projectId} AND "status" = 'CLAIMED'
      AND "claimAgentId" = ${agentId} AND "claimId" = ${claimId}
      AND "claimExpiresAt" > timezone('UTC', clock_timestamp())
    RETURNING "id", "status", "revision", "version", "claimId", "claimExpiresAt"
  `;
  if (!lease) throw new DomainError(409, "Task claim is no longer active.");
  return lease;
}

export async function releaseTaskClaim(token: string, taskId: string, claimId: string) {
  const { id: agentId, projectId } = await authenticateAgent(token);
  const [task] = await db.$queryRaw<{ id: string; status: string }[]>`
    UPDATE "Task"
    SET "status" = 'READY', "claimAgentId" = NULL, "claimId" = NULL, "claimExpiresAt" = NULL,
        "version" = "version" + 1, "updatedAt" = timezone('UTC', clock_timestamp())
    WHERE "id" = ${taskId} AND "projectId" = ${projectId} AND "status" = 'CLAIMED'
      AND "claimAgentId" = ${agentId} AND "claimId" = ${claimId}
      AND "claimExpiresAt" > timezone('UTC', clock_timestamp())
    RETURNING "id", "status"
  `;
  if (!task) throw new DomainError(409, "Task claim is no longer active.");
  return task;
}
