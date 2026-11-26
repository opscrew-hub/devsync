/** The inputs of DevSync's actions, its MCP tools (docs/host.md, MCP for coding agents). */
import { z } from "zod";
import { MessageText, SignalKind } from "./agents";
import { Counter, Id } from "./common";
import { AnswerInput, QuestionInput } from "./questions";
import { AgentUsage, TaskInput, TaskListQuery, TaskUpdate } from "./tasks";

/** `get_project_state` and `get_pending_signals`. */
export const NoInput = z.strictObject({});
export type NoInput = z.infer<typeof NoInput>;

/** `get_task`, `get_briefing` and `request_run`: one of the project's tasks. */
export const TaskRef = z.strictObject({ taskId: Id });
export type TaskRef = z.infer<typeof TaskRef>;

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

/** `create_task`, idempotent by `requestId`; a task from a security finding is a member's. */
export const AgentTaskInput = TaskInput.omit({ finding: true }).extend({ requestId: Id });
export type AgentTaskInput = z.infer<typeof AgentTaskInput>;

/** `update_task`: a task the agent created; it moves to Backlog or Ready only, and is never assigned. */
export const AgentTaskUpdate = TaskUpdate.omit({ assigneeUserId: true }).extend({
  taskId: Id,
  status: z.enum(["BACKLOG", "READY"]).optional(),
});
export type AgentTaskUpdate = z.infer<typeof AgentTaskUpdate>;

/** `report_blocker`, and the report `TaskReportInput` adds usage to. */
export const TaskActivityInput = z.strictObject({
  taskId: Id,
  claimId: Id,
  revision: Counter,
  requestId: Id,
  message: MessageText,
});
export type TaskActivityInput = z.infer<typeof TaskActivityInput>;

/** `report_progress` and `request_review`: a report, and what the agent used since its last one. */
export const TaskReportInput = TaskActivityInput.extend({ usage: AgentUsage.optional() });
export type TaskReportInput = z.infer<typeof TaskReportInput>;

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

/**
 * `ask_question`: a question on an open task, idempotent by `requestId`; with `wait`, the agent
 * holding the task's claim makes the task wait for the answer.
 */
export const AskQuestionInput = z.strictObject({
  taskId: Id,
  requestId: Id,
  text: QuestionInput.shape.text,
  wait: z.boolean().optional(),
});
export type AskQuestionInput = z.infer<typeof AskQuestionInput>;

/** `answer_question`: an answer to an open question, once. */
export const AnswerQuestionInput = z.strictObject({
  questionId: Id,
  answer: AnswerInput.shape.answer,
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

/** Each action's input, by the action's name; `list_tasks` takes `GET /tasks`' query. */
export const MCP_TOOL_INPUTS = {
  get_project_state: NoInput,
  list_tasks: TaskListQuery,
  get_task: TaskRef,
  get_briefing: TaskRef,
  get_pending_signals: NoInput,
  acknowledge_signal: AcknowledgeSignalInput,
  publish_signal: PublishSignalInput,
  claim_task: TaskClaimInput,
  renew_task_claim: TaskClaimInput,
  release_task: TaskClaimInput,
  create_task: AgentTaskInput,
  update_task: AgentTaskUpdate,
  report_progress: TaskReportInput,
  report_blocker: TaskActivityInput,
  ask_question: AskQuestionInput,
  answer_question: AnswerQuestionInput,
  request_review: TaskReportInput,
  submit_review: ReviewDecisionInput,
  request_run: TaskRef,
} as const;
export type McpToolName = keyof typeof MCP_TOOL_INPUTS;
