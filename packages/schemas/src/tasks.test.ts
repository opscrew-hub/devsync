import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CommentInput,
  PullRequestLink,
  PullRequestList,
  Task,
  TaskDetail,
  TaskInput,
  TaskListQuery,
  TaskUpdate,
  WorkspaceTaskList,
  WorkspaceTaskListQuery,
} from "./tasks";

const text = (length: number) => "a".repeat(length);
const now = new Date().toISOString();

function task(): Task {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    title: "Add a health route",
    status: "CLAIMED",
    revision: 1,
    version: 2,
    assigneeUserId: null,
    claim: { agentId: randomUUID(), agentName: "Builder", expiresAt: now },
    pullRequestNumber: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("TaskInput", () => {
  const valid = { title: "Ship it", description: "", acceptanceCriteria: "" };

  it("takes a title of 1 to 160 characters", () => {
    expect(TaskInput.safeParse({ ...valid, title: text(160) }).success).toBe(true);
    expect(TaskInput.safeParse({ ...valid, title: text(161) }).success).toBe(false);
    expect(TaskInput.safeParse({ ...valid, title: "   " }).success).toBe(false);
  });

  it("takes a description and criteria up to 8000 characters", () => {
    for (const field of ["description", "acceptanceCriteria"]) {
      expect(TaskInput.safeParse({ ...valid, [field]: text(8000) }).success).toBe(true);
      expect(TaskInput.safeParse({ ...valid, [field]: text(8001) }).success).toBe(false);
    }
  });

  it("trims and refuses unknown fields", () => {
    expect(TaskInput.parse({ ...valid, title: "  Ship it " }).title).toBe("Ship it");
    expect(TaskInput.safeParse({ ...valid, status: "DONE" }).success).toBe(false);
  });
});

describe("TaskUpdate", () => {
  it("needs a version and nothing else", () => {
    expect(TaskUpdate.safeParse({ version: 1 }).success).toBe(true);
    expect(TaskUpdate.safeParse({}).success).toBe(false);
    expect(TaskUpdate.safeParse({ version: 0 }).success).toBe(false);
  });

  it("takes any of the fields, a status and an assignee or null", () => {
    const update = {
      version: 3,
      title: "New",
      description: "d",
      acceptanceCriteria: "c",
      status: "READY",
      assigneeUserId: randomUUID(),
    };
    expect(TaskUpdate.safeParse(update).success).toBe(true);
    expect(TaskUpdate.safeParse({ version: 3, assigneeUserId: null }).success).toBe(true);
    expect(TaskUpdate.safeParse({ version: 3, assigneeUserId: "someone" }).success).toBe(false);
    expect(TaskUpdate.safeParse({ version: 3, status: "STARTED" }).success).toBe(false);
    expect(TaskUpdate.safeParse({ version: 3, title: text(161) }).success).toBe(false);
    expect(TaskUpdate.safeParse({ version: 3, assigneeId: null }).success).toBe(false);
  });
});

describe("CommentInput and PullRequestLink", () => {
  it("takes a comment of 1 to 4000 characters", () => {
    expect(CommentInput.safeParse({ body: text(4000) }).success).toBe(true);
    expect(CommentInput.safeParse({ body: text(4001) }).success).toBe(false);
    expect(CommentInput.safeParse({ body: " " }).success).toBe(false);
  });

  it("takes a positive pull request number, or null", () => {
    expect(PullRequestLink.safeParse({ number: 12 }).success).toBe(true);
    expect(PullRequestLink.safeParse({ number: null }).success).toBe(true);
    expect(PullRequestLink.safeParse({ number: 0 }).success).toBe(false);
    expect(PullRequestLink.safeParse({ number: 1.5 }).success).toBe(false);
    expect(PullRequestLink.safeParse({ number: 2 ** 31 }).success).toBe(false);
    expect(PullRequestLink.safeParse({}).success).toBe(false);
  });
});

describe("the list queries", () => {
  it("take a status and an assignee: me, none or a user id", () => {
    expect(TaskListQuery.safeParse({}).success).toBe(true);
    expect(TaskListQuery.safeParse({ status: "READY", assignee: "me" }).success).toBe(true);
    expect(TaskListQuery.safeParse({ assignee: "none" }).success).toBe(true);
    expect(TaskListQuery.safeParse({ assignee: randomUUID() }).success).toBe(true);
    expect(TaskListQuery.safeParse({ assignee: "bob" }).success).toBe(false);
    expect(TaskListQuery.safeParse({ status: "ready" }).success).toBe(false);
  });

  it("take a project on the workspace's list", () => {
    expect(WorkspaceTaskListQuery.safeParse({ project: randomUUID() }).success).toBe(true);
    expect(WorkspaceTaskListQuery.safeParse({ project: "x" }).success).toBe(false);
  });
});

describe("the answers", () => {
  it("parse a task, with UUID ids and ISO times", () => {
    const valid = task();
    expect(Task.parse(valid)).toEqual(valid);
    expect(Task.safeParse({ ...valid, claim: null }).success).toBe(true);
    expect(Task.safeParse({ ...task(), id: "1" }).success).toBe(false);
    expect(Task.safeParse({ ...task(), createdAt: "yesterday" }).success).toBe(false);
  });

  it("parse a task's detail with its authors", () => {
    const member = { kind: "member", userId: randomUUID(), name: "Ana" } as const;
    const agent = { kind: "agent", agentId: randomUUID(), name: "Builder" } as const;
    const detail = {
      ...task(),
      description: "",
      acceptanceCriteria: "",
      creator: member,
      revisions: [
        {
          number: 1,
          title: "t",
          description: "",
          acceptanceCriteria: "",
          author: agent,
          createdAt: now,
        },
      ],
      comments: [{ id: randomUUID(), author: member, body: "Looks good", createdAt: now }],
      timeline: [
        {
          id: randomUUID(),
          kind: "task.created",
          actor: member,
          message: null,
          revision: 1,
          createdAt: now,
        },
        {
          id: randomUUID(),
          kind: "pull_request.merged",
          actor: null,
          message: null,
          revision: null,
          createdAt: now,
        },
      ],
      pullRequest: null,
    };
    expect(TaskDetail.safeParse(detail).success).toBe(true);
    expect(
      TaskDetail.safeParse({
        ...detail,
        creator: { kind: "agent", userId: randomUUID(), name: "x" },
      }).success,
    ).toBe(false);
  });

  it("parse the workspace's tasks with their project's name", () => {
    expect(
      WorkspaceTaskList.safeParse({ tasks: [{ ...task(), projectName: "shop" }] }).success,
    ).toBe(true);
    expect(WorkspaceTaskList.safeParse({ tasks: [task()] }).success).toBe(false);
  });

  it("parse pull requests", () => {
    const pullRequest = {
      number: 4,
      title: "Fix",
      state: "merged",
      url: "https://github.com/o/r/pull/4",
      updatedAt: now,
    };
    expect(PullRequestList.safeParse({ pullRequests: [pullRequest] }).success).toBe(true);
    expect(
      PullRequestList.safeParse({ pullRequests: [{ ...pullRequest, state: "draft" }] }).success,
    ).toBe(false);
  });
});
