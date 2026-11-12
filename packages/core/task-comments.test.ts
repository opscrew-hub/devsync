import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("comments are persisted, scoped to their project, and restricted to writers", {
  skip: process.env.DEVSYNC_TEST_DB !== "1",
}, async () => {
  const { db } = await import("@devsync/db");
  const { createProject, createTask, createTaskComment, getTask, DomainError } = await import("./index.ts");
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const projectIds: string[] = [];
  const hasStatus = (status: number) => (error: unknown) => error instanceof DomainError && error.status === status;
  try {
    await db.user.createMany({ data: [{ id: ownerId, name: "Owner" }, { id: viewerId, name: "Viewer" }] });
    const project = await createProject(ownerId, { name: "Comments test", description: "" });
    projectIds.push(project.id);
    const otherProject = await createProject(ownerId, { name: "Other project", description: "" });
    projectIds.push(otherProject.id);
    const task = await createTask(ownerId, project.id, { title: "Test task", description: "", acceptanceCriteria: "" });
    await assert.rejects(getTask(viewerId, project.id, task.id), hasStatus(404));
    await assert.rejects(createTaskComment(ownerId, otherProject.id, task.id, { body: "Wrong project" }), hasStatus(404));
    await db.projectMember.create({ data: { projectId: project.id, userId: viewerId, role: "VIEWER" } });
    await assert.rejects(createTaskComment(viewerId, project.id, task.id, { body: "Viewer comment" }), hasStatus(403));
    await createTaskComment(ownerId, project.id, task.id, { body: "  Saved comment  " });
    const detail = await getTask(viewerId, project.id, task.id);
    assert.deepEqual(detail.comments.map(comment => [comment.author.name, comment.body]), [["Owner", "Saved comment"]]);
  } finally {
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, viewerId] } } });
    await db.$disconnect();
  }
});
