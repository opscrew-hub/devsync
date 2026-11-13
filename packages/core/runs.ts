import { db } from "@devsync/db";
import { runDecisionInput, runRequestInput } from "@devsync/contracts";
import { DomainError, requireProject } from "./index.ts";

export async function listRuns(userId: string, projectId: string, taskId?: string) {
  await requireProject(userId, projectId);
  return db.agentRun.findMany({
    where: { projectId, taskId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
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
    const existing = await tx.agentRun.findFirst({ where: { taskId, status: { in: ["REQUESTED", "QUEUED"] } } });
    if (existing) throw new DomainError(409, "This task already has a pending run.");
    return tx.agentRun.create({ data: { taskId, projectId, agentType, revision: task.revision, requestedById: userId } });
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
      where: { id: runId, projectId, status: { in: status === "CANCELLED" ? ["REQUESTED", "QUEUED"] : ["REQUESTED"] } },
      data: { status, decidedAt: new Date(), decidedById: userId },
    });
    if (!result.count) throw new DomainError(409, "The run has already been decided.");
    await tx.auditLog.create({ data: { projectId, actorId: userId, targetId: runId, action: "run." + status.toLowerCase(), details: { revision: run.revision } } });
    return { id: runId, status };
  });
}
