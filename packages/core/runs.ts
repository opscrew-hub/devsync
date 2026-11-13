import { randomUUID } from "node:crypto";
import { db } from "@devsync/db";
import { runDecisionInput, runRequestInput } from "@devsync/contracts";
import { DomainError, requireProject } from "./index.ts";

export async function listRuns(userId: string, projectId: string, taskId?: string) {
  await requireProject(userId, projectId);
  return db.agentRun.findMany({
    where: { projectId, taskId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
    omit: { dispatchToken: true },
    include: { task: { select: { title: true } } },
  });
}

export async function requestRun(userId: string, projectId: string, input: unknown) {
  await requireProject(userId, projectId, true);
  const { taskId, agentType } = runRequestInput.parse(input);
  return db.$transaction(async tx => {
    const [task] = await tx.$queryRaw<{ revision: number; status: string }[]>`
      SELECT "revision", "status" FROM "Task" WHERE "id" = ${taskId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    if (!task) throw new DomainError(404, "Task not found.");
    if (task.status !== "READY") throw new DomainError(409, "Move the task to Ready before requesting a run.");
    const existing = await tx.agentRun.findFirst({ where: { taskId, status: { in: ["REQUESTED", "QUEUED", "RUNNING"] } } });
    if (existing) throw new DomainError(409, "This task already has a pending run.");
    return tx.agentRun.create({ data: { taskId, projectId, agentType, revision: task.revision, requestedById: userId }, omit: { dispatchToken: true } });
  });
}

export async function decideRun(userId: string, projectId: string, runId: string, input: unknown) {
  const { role } = await requireProject(userId, projectId);
  const { status } = runDecisionInput.parse(input);
  if (role !== "OWNER" && role !== "ADMIN") throw new DomainError(403, "Project administrator access required.");
  return db.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id: runId, projectId } });
    if (!run) throw new DomainError(404, "Run not found.");
    const [task] = await tx.$queryRaw<{ revision: number; status: string }[]>`
      SELECT "revision", "status" FROM "Task" WHERE "id" = ${run.taskId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    if (status === "QUEUED" && (!task || task.revision !== run.revision || task.status !== "READY")) {
      throw new DomainError(409, "The task changed. Cancel this request and request a new run.");
    }
    const result = await tx.agentRun.updateMany({
      where: { id: runId, projectId, status: { in: status === "CANCELLED" ? ["REQUESTED", "QUEUED", "RUNNING"] : ["REQUESTED"] } },
      data: { status, finishedAt: status === "CANCELLED" ? new Date() : undefined, decidedAt: new Date(), decidedById: userId, dispatchToken: null, dispatchExpiresAt: null },
    });
    if (!result.count) throw new DomainError(409, "The run has already been decided.");
    await tx.auditLog.create({ data: { projectId, actorId: userId, targetId: runId, action: "run." + status.toLowerCase(), details: { revision: run.revision } } });
    return { id: runId, status };
  });
}

export async function reserveQueuedRun(agentType: "CODEX" | "CLAUDE") {
  const dispatchToken = randomUUID();
  const [reservation] = await db.$queryRaw<{
    id: string; projectId: string; taskId: string; revision: number; dispatchToken: string; dispatchExpiresAt: Date;
  }[]>`
    WITH candidate AS (
      SELECT run."id"
      FROM "AgentRun" run JOIN "Task" task ON task."id" = run."taskId" AND task."projectId" = run."projectId"
      WHERE run."status" = 'QUEUED' AND run."agentType" = ${agentType}::"AgentType"
        AND (run."dispatchExpiresAt" IS NULL OR run."dispatchExpiresAt" <= timezone('UTC', clock_timestamp()))
        AND task."status" = 'READY' AND task."revision" = run."revision"
      ORDER BY run."createdAt", run."id"
      LIMIT 1 FOR UPDATE OF run SKIP LOCKED
    )
    UPDATE "AgentRun" run
    SET "dispatchToken" = ${dispatchToken}, "dispatchExpiresAt" = timezone('UTC', clock_timestamp()) + interval '2 minutes'
    FROM candidate WHERE run."id" = candidate."id"
    RETURNING run."id", run."projectId", run."taskId", run."revision", run."dispatchToken", run."dispatchExpiresAt"
  `;
  return reservation ?? null;
}

export async function releaseRunReservation(id: string, dispatchToken: string) {
  const result = await db.agentRun.updateMany({
    where: { id, dispatchToken, status: "QUEUED" },
    data: { dispatchToken: null, dispatchExpiresAt: null },
  });
  return result.count === 1;
}

export async function startReservedRun(id: string, token: string) {
  return db.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id }, select: { taskId: true } });
    if (!run) return false;
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${run.taskId} FOR UPDATE`;
    const count = await tx.$executeRaw`
      UPDATE "AgentRun" run SET "status" = 'RUNNING', "startedAt" = timezone('UTC', clock_timestamp()),
        "dispatchExpiresAt" = timezone('UTC', clock_timestamp()) + interval '2 minutes'
      FROM "Task" task WHERE run."id" = ${id} AND task."id" = run."taskId"
        AND run."status" = 'QUEUED' AND run."dispatchToken" = ${token}
        AND run."dispatchExpiresAt" > timezone('UTC', clock_timestamp())
        AND task."status" = 'READY' AND task."revision" = run."revision"
    `;
    return count === 1;
  });
}

export async function finishReservedRun(id: string, token: string, outcome: "SUCCEEDED" | "FAILED") {
  return db.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id }, select: { taskId: true, projectId: true } });
    if (!run) return false;
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${run.taskId} AND "projectId" = ${run.projectId} FOR UPDATE`;
    const count = await tx.$executeRaw`
      UPDATE "AgentRun" run
      SET "status" = ${outcome}::"RunStatus", "finishedAt" = timezone('UTC', clock_timestamp()),
        "dispatchToken" = NULL, "dispatchExpiresAt" = NULL
      FROM "Task" task
      WHERE run."id" = ${id} AND task."id" = run."taskId" AND task."projectId" = run."projectId"
        AND run."status" = 'RUNNING' AND run."dispatchToken" = ${token}
        AND run."dispatchExpiresAt" > timezone('UTC', clock_timestamp())
        AND (${outcome} = 'FAILED' OR (task."status" = 'READY' AND task."revision" = run."revision"))
    `;
    return count === 1;
  });
}

export async function expireRunningRuns() {
  return db.$executeRaw`
    UPDATE "AgentRun" SET "status" = 'FAILED', "finishedAt" = timezone('UTC', clock_timestamp()),
      "dispatchToken" = NULL, "dispatchExpiresAt" = NULL
    WHERE "status" = 'RUNNING' AND "dispatchExpiresAt" <= timezone('UTC', clock_timestamp())
  `;
}

export async function renewRunningRun(id: string, token: string) {
  const [lease] = await db.$queryRaw<{ expiresAt: Date }[]>`
    UPDATE "AgentRun" run
    SET "dispatchExpiresAt" = timezone('UTC', clock_timestamp()) + interval '2 minutes'
    FROM "Task" task
    WHERE run."id" = ${id} AND run."taskId" = task."id" AND run."projectId" = task."projectId"
      AND run."status" = 'RUNNING' AND run."dispatchToken" = ${token}
      AND run."dispatchExpiresAt" > timezone('UTC', clock_timestamp())
      AND task."status" = 'READY' AND task."revision" = run."revision"
    RETURNING run."dispatchExpiresAt" AS "expiresAt"
  `;
  return lease ?? null;
}
