import { db } from "@devsync/db";
import { projectInput, taskInput, taskUpdate } from "@devsync/contracts";
import { transitions } from "./lifecycle";
export { transitions };
export class DomainError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
  const task = await db.task.findUnique({ where: { id, projectId }, include: { revisions: { orderBy: { number: "desc" } } } });
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
  const { version, status, ...patch } = taskUpdate.parse(input);
  const task = await getTask(userId, projectId, id);
  if (version !== task.version) throw new DomainError(409, "Task changed. Reload and try again.");
  if (status && status !== task.status && !transitions[task.status].includes(status)) {
    throw new DomainError(409, "Invalid status transition.");
  }
  const fields = { title: patch.title ?? task.title, description: patch.description ?? task.description, acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria };
  const revised = fields.title !== task.title || fields.description !== task.description || fields.acceptanceCriteria !== task.acceptanceCriteria;
  return db.$transaction(async tx => {
    const updated = await tx.task.updateMany({ where: { id, projectId, version }, data: { ...fields, status, version: { increment: 1 }, revision: revised ? { increment: 1 } : undefined } });
    if (!updated.count) throw new DomainError(409, "Task changed. Reload and try again.");
    if (revised) await tx.taskRevision.create({ data: { ...fields, taskId: id, number: task.revision + 1 } });
    return tx.task.findUniqueOrThrow({ where: { id } });
  });
}
