import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AcknowledgeSignalInput,
  AgentTaskInput,
  AgentTaskUpdate,
  AnswerQuestionInput,
  AskQuestionInput,
  MCP_TOOL_INPUTS,
  PublishSignalInput,
  ReviewDecisionInput,
  TaskActivityInput,
  TaskClaimInput,
  TaskRef,
  TaskReportInput,
} from "./mcp";

const text = (length: number) => "a".repeat(length);

describe("the MCP tools' inputs", () => {
  it("cover every tool of docs/host.md", () => {
    expect(Object.keys(MCP_TOOL_INPUTS).sort()).toEqual(
      [
        "get_project_state",
        "list_tasks",
        "get_task",
        "request_run",
        "get_pending_signals",
        "acknowledge_signal",
        "publish_signal",
        "claim_task",
        "renew_task_claim",
        "release_task",
        "create_task",
        "update_task",
        "report_progress",
        "report_blocker",
        "request_review",
        "submit_review",
        "ask_question",
        "answer_question",
        "get_briefing",
      ].sort(),
    );
    expect(MCP_TOOL_INPUTS.get_project_state.safeParse({}).success).toBe(true);
    expect(MCP_TOOL_INPUTS.get_project_state.safeParse({ x: 1 }).success).toBe(false);
  });

  it("list the tasks by status and assignee, and name one task by its id", () => {
    const list = MCP_TOOL_INPUTS.list_tasks;
    expect(list.safeParse({}).success).toBe(true);
    expect(list.safeParse({ status: "READY", assignee: "me" }).success).toBe(true);
    expect(list.safeParse({ assignee: randomUUID() }).success).toBe(true);
    expect(list.safeParse({ status: "DONE", assignee: "none" }).success).toBe(true);
    expect(list.safeParse({ status: "SHIPPED" }).success).toBe(false);
    expect(list.safeParse({ assignee: "someone" }).success).toBe(false);
    expect(list.safeParse({ projectId: randomUUID() }).success).toBe(false);
    expect(MCP_TOOL_INPUTS.get_task).toBe(TaskRef);
    expect(MCP_TOOL_INPUTS.request_run).toBe(TaskRef);
    expect(TaskRef.safeParse({ taskId: randomUUID() }).success).toBe(true);
    expect(TaskRef.safeParse({ taskId: "t1" }).success).toBe(false);
    expect(TaskRef.safeParse({ taskId: randomUUID(), extra: 1 }).success).toBe(false);
  });

  it("take UUID ids", () => {
    expect(AcknowledgeSignalInput.safeParse({ id: randomUUID() }).success).toBe(true);
    expect(AcknowledgeSignalInput.safeParse({ id: "s1" }).success).toBe(false);
    const claim = { taskId: randomUUID(), claimId: randomUUID() };
    expect(TaskClaimInput.safeParse(claim).success).toBe(true);
    expect(TaskClaimInput.safeParse({ ...claim, taskId: "t1" }).success).toBe(false);
  });

  it("take a signal for a peer with its fields and limits", () => {
    const signal = {
      recipientId: randomUUID(),
      kind: "review.requested",
      payload: { message: "Please review." },
      idempotencyKey: randomUUID(),
    };
    expect(PublishSignalInput.safeParse(signal).success).toBe(true);
    expect(PublishSignalInput.safeParse({ ...signal, replyToId: randomUUID() }).success).toBe(true);
    expect(
      PublishSignalInput.safeParse({ ...signal, payload: { message: text(4001) } }).success,
    ).toBe(false);
    expect(PublishSignalInput.safeParse({ ...signal, payload: { message: "" } }).success).toBe(
      false,
    );
  });

  it("take a task to create, idempotent by its request id", () => {
    const input = { requestId: randomUUID(), title: "t", description: "", acceptanceCriteria: "" };
    expect(AgentTaskInput.safeParse(input).success).toBe(true);
    expect(AgentTaskInput.safeParse({ ...input, title: text(161) }).success).toBe(false);
    expect(AgentTaskInput.safeParse({ ...input, requestId: "r" }).success).toBe(false);
    // A task from a security finding is a member's, made from the dashboard.
    expect(AgentTaskInput.safeParse({ ...input, finding: { fingerprint: "a:1" } }).success).toBe(
      false,
    );
  });

  it("let an agent move its task to Backlog or Ready only, and never assign it", () => {
    const update = { taskId: randomUUID(), version: 1 };
    expect(AgentTaskUpdate.safeParse(update).success).toBe(true);
    expect(AgentTaskUpdate.safeParse({ ...update, status: "BACKLOG" }).success).toBe(true);
    expect(AgentTaskUpdate.safeParse({ ...update, status: "READY" }).success).toBe(true);
    expect(AgentTaskUpdate.safeParse({ ...update, status: "DONE" }).success).toBe(false);
    expect(AgentTaskUpdate.safeParse({ ...update, assigneeUserId: null }).success).toBe(false);
    expect(AgentTaskUpdate.safeParse({ ...update, description: text(8001) }).success).toBe(false);
    expect(AgentTaskUpdate.safeParse({ taskId: randomUUID() }).success).toBe(false);
  });

  it("take a progress report, a blocker or a review request with a message up to 4000", () => {
    const activity = {
      taskId: randomUUID(),
      claimId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      message: "Halfway",
    };
    expect(TaskActivityInput.safeParse(activity).success).toBe(true);
    expect(TaskActivityInput.safeParse({ ...activity, message: text(4001) }).success).toBe(false);
    expect(TaskActivityInput.safeParse({ ...activity, revision: 0 }).success).toBe(false);
  });

  it("take the agent's usage with a progress report and a review request, not with a blocker", () => {
    const activity = {
      taskId: randomUUID(),
      claimId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      message: "Halfway",
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, model: "gpt-5" },
    };
    expect(MCP_TOOL_INPUTS.report_progress).toBe(TaskReportInput);
    expect(MCP_TOOL_INPUTS.request_review).toBe(TaskReportInput);
    expect(MCP_TOOL_INPUTS.report_blocker).toBe(TaskActivityInput);
    expect(TaskReportInput.safeParse(activity).success).toBe(true);
    expect(TaskReportInput.safeParse({ ...activity, usage: undefined }).success).toBe(true);
    expect(TaskReportInput.safeParse({ ...activity, usage: { inputTokens: -1 } }).success).toBe(
      false,
    );
    expect(TaskReportInput.safeParse({ ...activity, extra: 1 }).success).toBe(false);
    expect(TaskActivityInput.safeParse(activity).success).toBe(false);
  });

  it("take a task's paths, the tasks it waits for, its labels and branch, to create or edit", () => {
    const fields = {
      owns: ["src/"],
      dependsOn: [randomUUID()],
      labels: ["api"],
      branch: "feature/api",
    };
    const input = { requestId: randomUUID(), title: "t", description: "", acceptanceCriteria: "" };
    expect(AgentTaskInput.safeParse({ ...input, ...fields }).success).toBe(true);
    expect(AgentTaskInput.safeParse({ ...input, owns: ["/abs"] }).success).toBe(false);
    const update = { taskId: randomUUID(), version: 1 };
    expect(AgentTaskUpdate.safeParse({ ...update, ...fields }).success).toBe(true);
    expect(AgentTaskUpdate.safeParse({ ...update, branch: null }).success).toBe(true);
    expect(AgentTaskUpdate.safeParse({ ...update, branch: "a b" }).success).toBe(false);
  });

  it("take a question, waiting for its answer or not, idempotent by its request id", () => {
    const ask = { taskId: randomUUID(), requestId: randomUUID(), text: "Which port?" };
    expect(AskQuestionInput.safeParse(ask).success).toBe(true);
    expect(AskQuestionInput.safeParse({ ...ask, wait: true }).success).toBe(true);
    expect(AskQuestionInput.safeParse({ ...ask, wait: "yes" }).success).toBe(false);
    expect(AskQuestionInput.safeParse({ ...ask, text: text(4001) }).success).toBe(false);
    expect(AskQuestionInput.safeParse({ ...ask, text: " " }).success).toBe(false);
    expect(AskQuestionInput.safeParse({ ...ask, requestId: undefined }).success).toBe(false);
    expect(AskQuestionInput.safeParse({ ...ask, claimId: randomUUID() }).success).toBe(false);
  });

  it("take an answer to a question, and a task to brief", () => {
    const answer = { questionId: randomUUID(), answer: "8080" };
    expect(AnswerQuestionInput.safeParse(answer).success).toBe(true);
    expect(AnswerQuestionInput.safeParse({ ...answer, answer: text(4001) }).success).toBe(false);
    expect(AnswerQuestionInput.safeParse({ ...answer, questionId: "q1" }).success).toBe(false);
    expect(MCP_TOOL_INPUTS.ask_question).toBe(AskQuestionInput);
    expect(MCP_TOOL_INPUTS.answer_question).toBe(AnswerQuestionInput);
    expect(MCP_TOOL_INPUTS.get_briefing).toBe(TaskRef);
  });

  it("take a review decision", () => {
    const review = {
      taskId: randomUUID(),
      reviewRequestId: randomUUID(),
      revision: 2,
      requestId: randomUUID(),
      decision: "CHANGES_REQUESTED",
      message: "Add a test.",
    };
    expect(ReviewDecisionInput.safeParse(review).success).toBe(true);
    expect(ReviewDecisionInput.safeParse({ ...review, decision: "LGTM" }).success).toBe(false);
    expect(ReviewDecisionInput.safeParse({ ...review, message: text(4001) }).success).toBe(false);
  });
});
