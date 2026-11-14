import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AcknowledgeSignalInput,
  AgentTaskInput,
  AgentTaskUpdate,
  MCP_TOOL_INPUTS,
  PublishSignalInput,
  ReviewDecisionInput,
  TaskActivityInput,
  TaskClaimInput,
} from "./mcp";

const text = (length: number) => "a".repeat(length);

describe("the MCP tools' inputs", () => {
  it("cover every tool of docs/host.md", () => {
    expect(Object.keys(MCP_TOOL_INPUTS).sort()).toEqual(
      [
        "get_project_state",
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
      ].sort(),
    );
    expect(MCP_TOOL_INPUTS.get_project_state.safeParse({}).success).toBe(true);
    expect(MCP_TOOL_INPUTS.get_project_state.safeParse({ x: 1 }).success).toBe(false);
  });

  it("take UUID ids", () => {
    expect(AcknowledgeSignalInput.safeParse({ id: randomUUID() }).success).toBe(true);
    expect(AcknowledgeSignalInput.safeParse({ id: "s1" }).success).toBe(false);
    const claim = { taskId: randomUUID(), claimId: randomUUID() };
    expect(TaskClaimInput.safeParse(claim).success).toBe(true);
    expect(TaskClaimInput.safeParse({ ...claim, taskId: "t1" }).success).toBe(false);
  });

  it("take a signal for a peer with legacy's fields and limits", () => {
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
