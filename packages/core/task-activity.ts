import { db } from "@devsync/db";
import { reviewDecisionInput, taskActivityInput } from "@devsync/contracts";
import { authenticateAgent } from "./agent-signals.ts";
import { DomainError, requireProject } from "./index.ts";

type Activity = "implementation.progress" | "task.blocked" | "review.requested";
const labels = {
  "implementation.progress": "Progress reported",
  "task.blocked": "Blocker reported",
  "review.requested": "Review requested",
  "review.approved": "Review approved",
  "review.changes_requested": "Changes requested",
};

export async function reportTaskActivity(token: string, kind: Activity, input: unknown) {
  const { id: actorAgentId, projectId } = await authenticateAgent(token);
  const { taskId, claimId, revision, requestId, message } = taskActivityInput.parse(input);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actorAgentId} FOR NO KEY UPDATE`;
    const key = { projectId, actorAgentId, requestId };
    const existing = await tx.outboxEvent.findUnique({ where: { projectId_actorAgentId_requestId: key } });
    if (existing) {
      const payload = existing.payload;
      if (existing.taskId !== taskId || existing.kind !== kind || !payload || typeof payload !== "object" ||
          !("revision" in payload) || payload.revision !== revision ||
          !("message" in payload) || payload.message !== message) {
        throw new DomainError(409, "Request ID already used for another task report.");
      }
      return { id: existing.id, taskId, kind };
    }
    const [task] = await tx.$queryRaw<{ revision: number; active: boolean }[]>`
      SELECT "revision", COALESCE("status" = 'CLAIMED' AND "claimAgentId" = ${actorAgentId}
        AND "claimId" = ${claimId} AND "claimExpiresAt" > timezone('UTC', clock_timestamp()), false) AS "active"
      FROM "Task" WHERE "id" = ${taskId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    if (!task) throw new DomainError(404, "Task not found.");
    if (!task.active) throw new DomainError(409, "Task claim is no longer active.");
    if (task.revision !== revision) throw new DomainError(409, "Requirements changed. Read the latest revision before reporting.");
    let taskVersion: number | undefined;
    if (kind !== "implementation.progress") {
      const updated = await tx.task.update({
        where: { id: taskId, projectId },
        data: {
          status: kind === "task.blocked" ? "BLOCKED" : "REVIEW",
          claimAgentId: null, claimId: null, claimExpiresAt: null, version: { increment: 1 },
        },
        select: { version: true },
      });
      taskVersion = updated.version;
    }
    const event = await tx.outboxEvent.create({
      data: { ...key, taskId, kind, payload: { taskId, revision, message, ...(taskVersion === undefined ? {} : { taskVersion }) } },
      select: { id: true },
    });
    return { id: event.id, taskId, kind };
  });
}

export async function listTaskActivity(userId: string, projectId: string, taskId: string) {
  await requireProject(userId, projectId);
  const events = await db.outboxEvent.findMany({
    where: { projectId, taskId },
    select: { id: true, kind: true, createdAt: true, payload: true, actorAgent: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return events.flatMap(({ id, kind, createdAt, payload, actorAgent }) => {
    if (!Object.hasOwn(labels, kind) || !payload || typeof payload !== "object" ||
        !("message" in payload) || typeof payload.message !== "string") return [];
    return [{ id, createdAt, label: labels[kind as keyof typeof labels], message: payload.message, agentName: actorAgent?.name }];
  });
}

export async function submitReview(token: string, input: unknown) {
  const { id: actorAgentId, projectId } = await authenticateAgent(token);
  const { taskId, reviewRequestId, revision, requestId, decision, message } = reviewDecisionInput.parse(input);
  const kind = decision === "APPROVED" ? "review.approved" : "review.changes_requested";
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actorAgentId} FOR NO KEY UPDATE`;
    const key = { projectId, actorAgentId, requestId };
    const existing = await tx.outboxEvent.findUnique({ where: { projectId_actorAgentId_requestId: key } });
    if (existing) {
      const payload = existing.payload;
      if (existing.taskId !== taskId || existing.kind !== kind || existing.reviewRequestId !== reviewRequestId ||
          !payload || typeof payload !== "object" || !("revision" in payload) || payload.revision !== revision ||
          !("message" in payload) || payload.message !== message) {
        throw new DomainError(409, "Request ID already used for another task report.");
      }
      return { id: existing.id, taskId, kind };
    }
    const [task] = await tx.$queryRaw<{ status: string; revision: number; version: number }[]>`
      SELECT "status", "revision", "version" FROM "Task"
      WHERE "id" = ${taskId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    if (!task) throw new DomainError(404, "Task not found.");
    const request = await tx.outboxEvent.findFirst({
      where: { projectId, taskId, kind: "review.requested" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, actorAgentId: true, payload: true, reviewDecision: { select: { id: true } } },
    });
    if (!request || request.id !== reviewRequestId) throw new DomainError(409, "Review request is no longer current.");
    if (request.actorAgentId === actorAgentId) throw new DomainError(403, "A peer agent must review this request.");
    if (request.reviewDecision) throw new DomainError(409, "This request already has a review decision.");
    const payload = request.payload;
    if (task.status !== "REVIEW" || task.revision !== revision ||
        !payload || typeof payload !== "object" || !("revision" in payload) || payload.revision !== revision ||
        ("taskVersion" in payload && payload.taskVersion !== task.version)) {
      throw new DomainError(409, "Task changed. Request a new review.");
    }
    if (decision === "CHANGES_REQUESTED") {
      await tx.task.update({
        where: { id: taskId, projectId },
        data: { status: "READY", version: { increment: 1 } },
      });
    }
    const event = await tx.outboxEvent.create({
      data: { ...key, taskId, reviewRequestId, kind, payload: { taskId, reviewRequestId, revision, message } },
      select: { id: true },
    });
    return { id: event.id, taskId, kind };
  });
}
