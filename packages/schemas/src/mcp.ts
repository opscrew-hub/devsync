/** The MCP tools' inputs (docs/host.md, MCP for coding agents). */
import { z } from "zod";
import { MessageText, SignalKind } from "./agents";
import { Counter, Id } from "./common";
import { TaskInput, TaskUpdate } from "./tasks";

/** `get_project_state` and `get_pending_signals`. */
export const NoInput = z.strictObject({});
export type NoInput = z.infer<typeof NoInput>;

/** `acknowledge_signal`. */
export const AcknowledgeSignalInput = z.strictObject({ id: Id });
export type AcknowledgeSignalInput = z.infer<typeof AcknowledgeSignalInput>;

/** `publish_signal`: to a peer agent, optionally replying to a signal. */
export const PublishSignalInput = z.strictObject({
  recipientId: Id,
  kind: SignalKind,
  payload: z.strictObject({ message: MessageText }),
  idempotencyKey: Id,
  replyToId: Id.optional(),
});
export type PublishSignalInput = z.infer<typeof PublishSignalInput>;

/** `claim_task`, `renew_task_claim` and `release_task`. */
export const TaskClaimInput = z.strictObject({ taskId: Id, claimId: Id });
export type TaskClaimInput = z.infer<typeof TaskClaimInput>;

/** `create_task`, idempotent by `requestId`. */
export const AgentTaskInput = TaskInput.extend({ requestId: Id });
export type AgentTaskInput = z.infer<typeof AgentTaskInput>;

/** `update_task`: a task the agent created; it moves to Backlog or Ready only, and is never assigned. */
export const AgentTaskUpdate = TaskUpdate.omit({ assigneeUserId: true }).extend({
  taskId: Id,
  status: z.enum(["BACKLOG", "READY"]).optional(),
});
export type AgentTaskUpdate = z.infer<typeof AgentTaskUpdate>;

/** `report_progress`, `report_blocker` and `request_review`. */
export const TaskActivityInput = z.strictObject({
  taskId: Id,
  claimId: Id,
  revision: Counter,
  requestId: Id,
  message: MessageText,
});
export type TaskActivityInput = z.infer<typeof TaskActivityInput>;

/** `submit_review`: a peer's decision on a review request. */
export const ReviewDecisionInput = z.strictObject({
  taskId: Id,
  reviewRequestId: Id,
  revision: Counter,
  requestId: Id,
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  message: MessageText,
});
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInput>;

/** Each tool's input, by the tool's name. */
export const MCP_TOOL_INPUTS = {
  get_project_state: NoInput,
  get_pending_signals: NoInput,
  acknowledge_signal: AcknowledgeSignalInput,
  publish_signal: PublishSignalInput,
  claim_task: TaskClaimInput,
  renew_task_claim: TaskClaimInput,
  release_task: TaskClaimInput,
  create_task: AgentTaskInput,
  update_task: AgentTaskUpdate,
  report_progress: TaskActivityInput,
  report_blocker: TaskActivityInput,
  request_review: TaskActivityInput,
  submit_review: ReviewDecisionInput,
} as const;
export type McpToolName = keyof typeof MCP_TOOL_INPUTS;
