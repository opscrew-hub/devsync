import { z } from "zod";
export const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
});
export const taskInput = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(8000),
  acceptanceCriteria: z.string().trim().max(8000),
});
export const statuses = ["BACKLOG", "READY", "CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE", "CANCELLED"] as const;
export const taskUpdate = taskInput.partial().extend({
  assigneeId: z.string().min(1).max(40).nullable().optional(),
  version: z.number().int().positive(),
  status: z.enum(statuses).optional(),
});
export const taskCommentInput = z.object({ body: z.string().trim().min(1).max(4000) });
export const memberInput = z.object({
  userId: z.string().trim().min(1).max(40),
  role: z.enum(["ADMIN", "DEVELOPER", "VIEWER"]).nullable(),
});

export const agentInput = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["CODEX", "CLAUDE"]),
});
export const signalInput = z.object({
  recipientId: z.string().min(1).max(40),
  kind: z.enum(["clarification.requested", "clarification.answered", "review.requested", "system.warning"]),
  payload: z.object({ message: z.string().trim().min(1).max(4000) }),
  idempotencyKey: z.uuid(),
});

export const agentSignalInput = signalInput.extend({
  replyToId: z.string().min(1).max(40).optional(),
});

export const agentTaskInput = taskInput.extend({ requestId: z.uuid() });
export const agentTaskUpdate = taskUpdate.omit({ assigneeId: true }).extend({
  status: z.enum(["BACKLOG", "READY"]).optional(),
});

export const taskActivityInput = z.object({
  taskId: z.string().min(1).max(40),
  claimId: z.uuid(),
  revision: z.number().int().positive(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
});

export const reviewDecisionInput = z.object({
  taskId: z.string().min(1).max(40),
  reviewRequestId: z.string().min(1).max(40),
  revision: z.number().int().positive(),
  requestId: z.uuid(),
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  message: z.string().trim().min(1).max(4000),
});

export const githubWebhookEnvelope = z.object({
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ id: z.number().int().positive() }).passthrough(),
}).catchall(z.json());
