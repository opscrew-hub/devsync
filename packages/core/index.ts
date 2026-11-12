import { db } from "@devsync/db";
import { agentTaskInput, agentTaskUpdate, memberInput, projectInput, taskCommentInput, taskInput, taskUpdate } from "@devsync/contracts";
import { authenticateAgent } from "./agent-signals.ts";
import { transitions } from "./lifecycle.ts";
export { transitions };
export class DomainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function requireProject(userId: string, projectId: string, write = false) {
  const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { project: true } });
  if (!member) throw new DomainError(404, "Project not found.");
  if (write && member.role === "VIEWER") throw new DomainError(403, "Project is read-only for this account.");
  return member;
}
export function listProjects(userId: string) {
  return db.project.findMany({ where: { members: { some: { userId } } }, orderBy: { createdAt: "desc" } });
}
export function createProject(userId: string, input: unknown) {
  const fields = projectInput.parse(input);
  return db.$transaction(async tx => {
    const project = await tx.project.create({ data: { ...fields, members: { create: { userId, role: "OWNER" } } } });
    await tx.auditLog.create({ data: {
      projectId: project.id, actorId: userId, action: "project.created", targetId: project.id, details: {},
    } });
    return project;
  });
}
export async function listTasks(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return db.task.findMany({ where: { projectId }, orderBy: { updatedAt: "desc" } });
}
export async function getTask(userId: string, projectId: string, id: string) {
  await requireProject(userId, projectId);
  const task = await db.task.findUnique({ where: { id, projectId }, include: { revisions: { orderBy: { number: "desc" } }, comments: { include: { author: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
  if (!task) throw new DomainError(404, "Task not found.");
  return task;
}
export async function createTask(userId: string, projectId: string, input: unknown) {
  await requireProject(userId, projectId, true);
  return saveNewTask(projectId, taskInput.parse(input), { userId });
}

export async function createAgentTask(token: string, input: unknown) {
  const { id: agentId, projectId } = await authenticateAgent(token);
  const { requestId, ...fields } = agentTaskInput.parse(input);
  return saveNewTask(projectId, fields, { agentId, requestId });
}

async function saveNewTask(
  projectId: string,
  fields: ReturnType<typeof taskInput.parse>,
  actor: { userId: string } | { agentId: string; requestId: string },
) {
  return db.$transaction(async tx => {
    if ("agentId" in actor) {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actor.agentId} FOR NO KEY UPDATE`;
      const existing = await tx.task.findUnique({
        where: { projectId_creatorAgentId_createRequestId: {
          projectId, creatorAgentId: actor.agentId, createRequestId: actor.requestId,
        } },
        include: { revisions: { where: { number: 1 } } },
      });
      if (existing) {
        const { revisions: [original], ...task } = existing;
        if (!original || original.title !== fields.title || original.description !== fields.description ||
            original.acceptanceCriteria !== fields.acceptanceCriteria) {
          throw new DomainError(409, "Request ID already used for another task.");
        }
        return task;
      }
    }
    const creator = "userId" in actor
      ? { creatorId: actor.userId }
      : { creatorAgentId: actor.agentId, createRequestId: actor.requestId };
    const task = await tx.task.create({
      data: { ...fields, ...creator, projectId, revisions: { create: { ...fields, number: 1 } } },
    });
    await tx.outboxEvent.create({ data: {
      projectId, ...eventActor(actor), kind: "task.created",
      payload: { taskId: task.id, revision: task.revision, version: task.version, message: "Task created: " + task.title },
    } });
    return task;
  });
}

type TaskActor = { userId: string } | { agentId: string };

function eventActor(actor: TaskActor) {
  return "userId" in actor ? { actorId: actor.userId } : { actorAgentId: actor.agentId };
}

export async function updateTask(userId: string, projectId: string, id: string, input: unknown) {
  await requireProject(userId, projectId, true);
  return saveTaskEdit(projectId, id, taskUpdate.parse(input), { userId });
}

export async function updateAgentTask(token: string, id: string, input: unknown) {
  const { id: agentId, projectId } = await authenticateAgent(token);
  return saveTaskEdit(projectId, id, agentTaskUpdate.parse(input), { agentId });
}

async function saveTaskEdit(projectId: string, id: string, input: ReturnType<typeof taskUpdate.parse>, actor: TaskActor) {
  const { version, status, assigneeId, ...patch } = input;
  const task = await db.task.findUnique({ where: { id, projectId } });
  if (!task) throw new DomainError(404, "Task not found.");
  if ("agentId" in actor && task.creatorAgentId !== actor.agentId) throw new DomainError(403, "Agents may edit tasks they created.");
  if (version !== task.version) throw new DomainError(409, "Task changed. Reload and try again.");
  if (task.status === "CLAIMED" && status && status !== "CLAIMED" && status !== "CANCELLED") {
    throw new DomainError(409, "Release the agent claim before changing the task status.");
  }
  if (status && status !== task.status && !transitions[task.status].includes(status)) {
    throw new DomainError(409, "Invalid status transition.");
  }
  const fields = { title: patch.title ?? task.title, description: patch.description ?? task.description, acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria };
  const revised = fields.title !== task.title || fields.description !== task.description || fields.acceptanceCriteria !== task.acceptanceCriteria;
  return db.$transaction(async tx => {
    if ("userId" in actor && assigneeId !== undefined) {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
      const writer = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: actor.userId } } });
      if (!writer || writer.role === "VIEWER") throw new DomainError(403, "Project write access required.");
      if (assigneeId !== null) {
        const assignee = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: assigneeId } } });
        if (!assignee || assignee.role === "VIEWER") throw new DomainError(400, "Choose a project member with write access.");
      }
    }
    const updated = await tx.task.updateMany({ where: { id, projectId, version }, data: { ...fields, status, assigneeId, ...(status === "CANCELLED" ? { claimAgentId: null, claimId: null, claimExpiresAt: null } : {}), version: { increment: 1 }, revision: revised ? { increment: 1 } : undefined } });
    if (!updated.count) throw new DomainError(409, "Task changed. Reload and try again.");
    if (revised) await tx.taskRevision.create({ data: { ...fields, taskId: id, number: task.revision + 1 } });
    const saved = await tx.task.findUniqueOrThrow({ where: { id } });
    if (revised || saved.status !== task.status || saved.assigneeId !== task.assigneeId) {
      const kind = revised ? "requirements.changed" : saved.status === "BLOCKED" ? "task.blocked" :
        saved.assigneeId !== task.assigneeId ? "task.assigned" : "task.updated";
      await tx.outboxEvent.create({ data: {
        projectId, ...eventActor(actor), kind,
        payload: { taskId: id, revision: saved.revision, version: saved.version, message: kind + ": " + saved.title },
      } });
    }
    return saved;
  });
}

export async function createTaskComment(userId: string, projectId: string, id: string, input: unknown) {
  const { body } = taskCommentInput.parse(input);
  await requireProject(userId, projectId, true);
  const task = await db.task.findUnique({ where: { id, projectId }, select: { id: true } });
  if (!task) throw new DomainError(404, "Task not found.");
  return db.taskComment.create({ data: { taskId: id, authorId: userId, body } });
}

export async function listProjectMembers(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return db.projectMember.findMany({
    where: { projectId },
    select: { userId: true, role: true, user: { select: { name: true } } },
    orderBy: { userId: "asc" },
  });
}

export async function changeProjectMember(actorId: string, projectId: string, input: unknown) {
  const { userId, role } = memberInput.parse(input);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const actor = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: actorId } } });
    if (!actor) throw new DomainError(404, "Project not found.");
    if (actor.role !== "OWNER") throw new DomainError(403, "Only project owners can manage access.");
    const key = { projectId, userId };
    const target = await tx.projectMember.findUnique({ where: { projectId_userId: key } });
    if (target?.role === "OWNER") throw new DomainError(409, "Project owner access cannot be changed.");
    if (role === null || role === "VIEWER") {
      await tx.task.updateMany({
        where: { projectId, assigneeId: userId },
        data: { assigneeId: null, version: { increment: 1 } },
      });
    }
    if (role === null) {
      await tx.projectMember.deleteMany({ where: key });
    } else {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new DomainError(404, "Account not found. Ask the member to sign in first.");
      await tx.projectMember.upsert({ where: { projectId_userId: key }, create: { ...key, role }, update: { role } });
    }
    if ((target?.role ?? null) !== role) {
      await tx.auditLog.create({ data: {
        projectId, actorId, action: "member.access_changed", targetId: userId,
        details: { previousRole: target?.role ?? null, role },
      } });
    }
    return { userId, role };
  });
}

export async function listProjectAudit(userId: string, projectId: string) {
  const member = await requireProject(userId, projectId);
  if (member.role !== "OWNER" && member.role !== "ADMIN") {
    throw new DomainError(403, "Project administrator access required.");
  }
  return db.auditLog.findMany({
    where: { projectId },
    include: { actor: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
}
