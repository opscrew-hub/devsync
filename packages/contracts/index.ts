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

export const githubRepositoryInput = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
});
export const githubTokenResponse = z.object({ token: z.string().min(1) });
export const githubRepositoryResponse = z.object({ id: z.number().int().positive(), full_name: z.string().min(1).max(300) });
export const taskPullRequestInput = z.object({ number: z.number().int().positive().max(2147483647).nullable() });
const branches = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) }));
const pulls = z.array(z.object({ number: z.number().int(), title: z.string(), state: z.string() }));
export const githubSnapshotChecks = z.object({ check_runs: z.array(z.object({ id: z.number().int(), name: z.string(), status: z.string(), conclusion: z.string().nullable() })) });
export const githubSnapshot = z.object({
  fetchedAt: z.string(),
  branches, pulls, checks: githubSnapshotChecks.shape.check_runs,
});


export const githubSnapshotMetadata = z.object({ id: z.number().int(), full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), default_branch: z.string().min(1) });

export const runRequestInput = z.object({ taskId: z.string().min(1).max(40), agentType: z.enum(["CODEX", "CLAUDE"]) });
export const runDecisionInput = z.object({ status: z.enum(["QUEUED", "REJECTED", "CANCELLED"]) });
