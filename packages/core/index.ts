import { db } from "@devsync/db";
import { memberInput, projectInput, taskCommentInput, taskInput, taskUpdate } from "@devsync/contracts";
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
  return db.project.create({ data: { ...projectInput.parse(input), members: { create: { userId, role: "OWNER" } } } });
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
  const fields = taskInput.parse(input);
  return db.task.create({ data: { ...fields, projectId, creatorId: userId, revisions: { create: { ...fields, number: 1 } } } });
}
export async function updateTask(userId: string, projectId: string, id: string, input: unknown) {
  await requireProject(userId, projectId, true);
  const { version, status, assigneeId, ...patch } = taskUpdate.parse(input);
  const task = await db.task.findUnique({ where: { id, projectId } });
  if (!task) throw new DomainError(404, "Task not found.");
  if (version !== task.version) throw new DomainError(409, "Task changed. Reload and try again.");
  if (status && status !== task.status && !transitions[task.status].includes(status)) {
    throw new DomainError(409, "Invalid status transition.");
  }
  const fields = { title: patch.title ?? task.title, description: patch.description ?? task.description, acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria };
  const revised = fields.title !== task.title || fields.description !== task.description || fields.acceptanceCriteria !== task.acceptanceCriteria;
  return db.$transaction(async tx => {
    if (assigneeId !== undefined) {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
      const writer = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
      if (!writer || writer.role === "VIEWER") throw new DomainError(403, "Project write access required.");
      if (assigneeId !== null) {
        const assignee = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: assigneeId } } });
        if (!assignee || assignee.role === "VIEWER") throw new DomainError(400, "Choose a project member with write access.");
      }
    }
    const updated = await tx.task.updateMany({ where: { id, projectId, version }, data: { ...fields, status, assigneeId, version: { increment: 1 }, revision: revised ? { increment: 1 } : undefined } });
    if (!updated.count) throw new DomainError(409, "Task changed. Reload and try again.");
    if (revised) await tx.taskRevision.create({ data: { ...fields, taskId: id, number: task.revision + 1 } });
    return tx.task.findUniqueOrThrow({ where: { id } });
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
    return { userId, role };
  });
}
