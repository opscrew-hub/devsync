import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentUsage,
  BranchName,
  CommentInput,
  isBranchName,
  isRepositoryPath,
  PullRequestLink,
  PullRequestList,
  Task,
  TaskDetail,
  TaskFields,
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
    owns: ["src/checkout/"],
    dependsOn: [randomUUID()],
    labels: ["payments"],
    branch: "feature/checkout",
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

  it("takes a security finding's fingerprint, and nothing else of the finding", () => {
    const finding = { fingerprint: "config/client-exposed-secret:src/app.ts:12" };
    expect(TaskInput.parse({ ...valid, finding }).finding).toEqual(finding);
    expect(TaskInput.safeParse({ ...valid, finding: { fingerprint: "a b" } }).success).toBe(false);
    expect(
      TaskInput.safeParse({ ...valid, finding: { ...finding, ruleId: "config/x" } }).success,
    ).toBe(false);
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

describe("a task's fields beyond its requirements", () => {
  const valid = { title: "Ship it", description: "", acceptanceCriteria: "" };

  it("are optional on a new task and on an edit, and none of them is a requirement", () => {
    expect(TaskInput.parse(valid)).toEqual(valid);
    expect(TaskUpdate.parse({ version: 1 })).toEqual({ version: 1 });
    const fields = {
      owns: ["src/checkout/", "README.md"],
      dependsOn: [randomUUID()],
      labels: ["payments", "ui"],
      branch: "feature/checkout",
    };
    expect(TaskInput.parse({ ...valid, ...fields })).toEqual({ ...valid, ...fields });
    expect(TaskUpdate.parse({ version: 2, ...fields })).toEqual({ version: 2, ...fields });
    expect(TaskUpdate.parse({ version: 2, branch: null }).branch).toBeNull();
    expect(Object.keys(TaskFields.shape).sort()).toEqual(["branch", "dependsOn", "labels", "owns"]);
  });

  it("take at most 50 paths, each relative to the repository's root, at most 400 characters", () => {
    const owns = (paths: string[]) => TaskFields.safeParse({ owns: paths }).success;
    expect(owns(["src/", "src/app.ts", ".github/workflows/ci.yml", "a..b/c"])).toBe(true);
    expect(owns(Array.from({ length: 50 }, (_, i) => `f${i}`))).toBe(true);
    expect(owns(Array.from({ length: 51 }, (_, i) => `f${i}`))).toBe(false);
    expect(owns([text(400)])).toBe(true);
    expect(owns([text(401)])).toBe(false);
    for (const bad of [
      "/etc/passwd",
      "../up",
      "src/../x",
      "a\u0000b",
      "",
      " ",
      "a//b",
      "./a",
      "/",
    ]) {
      expect(owns([bad]), JSON.stringify(bad)).toBe(false);
    }
    // Each path once: the same path twice is a mistake.
    expect(owns(["src/", "src/"])).toBe(false);
    expect(TaskFields.parse({ owns: ["  src/app.ts "] }).owns).toEqual(["src/app.ts"]);
    expect(isRepositoryPath("docs/")).toBe(true);
    expect(isRepositoryPath("docs/.")).toBe(false);
  });

  it("wait for at most 20 tasks, each once", () => {
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    expect(TaskFields.safeParse({ dependsOn: ids(20) }).success).toBe(true);
    expect(TaskFields.safeParse({ dependsOn: ids(21) }).success).toBe(false);
    const one = randomUUID();
    expect(TaskFields.safeParse({ dependsOn: [one, one] }).success).toBe(false);
    expect(TaskFields.safeParse({ dependsOn: ["t1"] }).success).toBe(false);
  });

  it("take at most 10 labels of 1 to 40 characters, trimmed and each once whatever its case", () => {
    const labels = (list: string[]) => TaskFields.safeParse({ labels: list }).success;
    expect(labels(Array.from({ length: 10 }, (_, i) => `l${i}`))).toBe(true);
    expect(labels(Array.from({ length: 11 }, (_, i) => `l${i}`))).toBe(false);
    expect(labels([text(40)])).toBe(true);
    expect(labels([text(41)])).toBe(false);
    expect(labels(["  "])).toBe(false);
    expect(labels(["UI", "ui"])).toBe(false);
    expect(labels(["ui ", " ui"])).toBe(false);
    expect(TaskFields.parse({ labels: ["  Payments "] }).labels).toEqual(["Payments"]);
  });

  it("take a branch named as git allows, at most 200 characters, or null", () => {
    for (const good of ["main", "feature/checkout", "fix-12", "release/2.x", "a.b", "user@host"]) {
      expect(isBranchName(good), good).toBe(true);
      expect(BranchName.safeParse(good).success, good).toBe(true);
    }
    for (const bad of [
      "has space",
      "a..b",
      "-leading",
      "tilde~",
      "caret^",
      "colon:",
      "question?",
      "star*",
      "bracket[",
      "back\\slash",
      "ends/",
      "/starts",
      "double//slash",
      "ends.lock",
      "part.lock/x",
      ".hidden",
      "x/.hidden",
      "ends.",
      "at@{brace",
      "@",
      "HEAD",
      "tab\tchar",
      "del\u007f",
    ]) {
      expect(isBranchName(bad), JSON.stringify(bad)).toBe(false);
      expect(BranchName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(BranchName.safeParse(text(200)).success).toBe(true);
    expect(BranchName.safeParse(text(201)).success).toBe(false);
    expect(BranchName.safeParse("").success).toBe(false);
    expect(BranchName.parse(" main ")).toBe("main");
  });
});

describe("AgentUsage", () => {
  it("takes whole token counts, a cost and a model, each optional and none negative", () => {
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5000,
      costUsd: 0.42,
      model: "claude-opus",
    };
    expect(AgentUsage.parse(usage)).toEqual(usage);
    expect(AgentUsage.safeParse({}).success).toBe(true);
    expect(AgentUsage.safeParse({ costUsd: 0 }).success).toBe(true);
    for (const bad of [
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { cacheReadInputTokens: "10" },
      { costUsd: -0.01 },
      { costUsd: Number.POSITIVE_INFINITY },
      { model: text(101) },
      { model: " " },
      { turns: 3 },
    ]) {
      expect(AgentUsage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(AgentUsage.safeParse({ model: text(100) }).success).toBe(true);
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
      dependencies: [{ id: randomUUID(), title: "Add a cart", status: "REVIEW" }],
      overlaps: [
        {
          task: { id: randomUUID(), title: "Restyle checkout", status: "READY" },
          paths: ["src/checkout/total.ts"],
        },
      ],
      usage: {
        agents: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 5000,
          costUsd: 0.42,
          models: ["claude-opus"],
          count: 2,
        },
        runs: null,
      },
    };
    expect(TaskDetail.safeParse(detail).success).toBe(true);
    expect(TaskDetail.safeParse({ ...detail, usage: { agents: null } }).success).toBe(false);
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
