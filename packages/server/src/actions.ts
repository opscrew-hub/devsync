/**
 * DevSync's actions (docs/platform.md, Actions): each MCP tool declared once. The host serves them
 * at `/mcp` as `devsync_<name>`, adding the project, and to its chat and other modules;
 * DevSync's own MCP endpoint (http/mcp.ts) serves the same list until it goes, so the two never
 * differ. DevSync's permission checks stay `can()`'s, in the domain, so no action names a host
 * permission.
 *
 * Callers: a member acts with their role; an agent acts as itself (`callerActor`); a managed run
 * reads the project's state and its tasks only. An action answers DevSync's refusals as its
 * result, `{ refused: { code, message } }`, and throws only for a fault, which the host reports as
 * "failed".
 */
import { MCP_TOOL_INPUTS, type McpToolName } from "@devsync/schemas";
import type { z } from "zod";
import { reportBlocker, reportProgress, requestReview, submitReview } from "./domain/activity";
import { callerActor } from "./domain/agents";
import { claimTask, releaseTask, renewTaskClaim } from "./domain/claims";
import { checkRunRequest, listRuns } from "./domain/runs";
import {
  acknowledgeSignal,
  agentProjectState,
  pendingSignals,
  publishAgentSignal,
} from "./domain/signals";
import {
  createTask,
  getTask,
  listTasks,
  type TaskActor,
  type TaskReader,
  updateTask,
} from "./domain/tasks";
import {
  type AgentActor,
  type DevSyncAction,
  type DevSyncActionContext,
  DevSyncError,
  type ErrorCode,
  type ProjectContext,
} from "./host";

/**
 * The rules a coding agent needs: each is in the descriptions of the actions it concerns, since
 * the host's `/mcp` lists only actions, and all of them are DevSync's own endpoint's instructions.
 */
export const ACTION_RULES = {
  start:
    "At the start of an assignment, read the project's state and your pending signals, and acknowledge each signal once processed.",
  claim: "Claim a task before working on it.",
  renew:
    "Renew the claim within 15 minutes while you work, or it expires and another agent may take the task.",
  blocker: "When you are stuck, report a blocker instead of waiting.",
  review: "When the work is done, request a review.",
  recall: "When memory tools are listed, recall what is known about the task before working on it.",
  remember: "When memory tools are listed, remember what you learned before requesting a review.",
} as const;

/** DevSync's own MCP endpoint's `instructions`: what DevSync is, and every rule. */
export const MCP_INSTRUCTIONS = [
  "DevSync holds this project's planned work: its tasks, their requirements, and the agents' claims, reports and reviews.",
  ...Object.values(ACTION_RULES),
].join(" ");

/** DevSync's refusal, answered as an action's result. */
export interface Refused {
  refused: { code: ErrorCode; message: string };
}

/** Whether an action's result is DevSync's refusal. */
export function isRefused(result: unknown): result is Refused {
  return typeof result === "object" && result !== null && "refused" in result;
}

/** What a managed run is told for anything but reading the project's state and its tasks. */
const RUN_READS_ONLY =
  "A managed run can only read the project's state and its tasks; what it changes reaches the task through its draft pull request.";

function runReadsOnly(): DevSyncError {
  return new DevSyncError("forbidden", RUN_READS_ONLY);
}

/** The member calling, with their role, as a project route's context. */
function memberOf(ctx: DevSyncActionContext): ProjectContext | null {
  const { caller, project } = ctx;
  if (caller.kind !== "member") return null;
  return { project, member: { userId: caller.userId, name: caller.name, role: caller.role } };
}

/** A reader of the project: a member, an agent, or a managed run, which has only its project. */
async function reader(ctx: DevSyncActionContext): Promise<TaskReader> {
  const { caller, project, host } = ctx;
  if (caller.kind === "agent") return callerActor(host, project, caller);
  return memberOf(ctx) ?? { project };
}

/** Who may change a task through an action: a member (by their role) or an agent; never a run. */
async function writer(ctx: DevSyncActionContext): Promise<TaskActor> {
  const { caller, project, host } = ctx;
  if (caller.kind === "agent") return callerActor(host, project, caller);
  const member = memberOf(ctx);
  if (!member) throw runReadsOnly();
  return member;
}

/** The agent calling an agents-only action: a member is told only an agent does it (`what`). */
async function agentOnly(ctx: DevSyncActionContext, what: string): Promise<AgentActor> {
  const { caller, project, host } = ctx;
  if (caller.kind === "agent") return callerActor(host, project, caller);
  if (caller.kind === "run") throw runReadsOnly();
  throw new DevSyncError(
    "forbidden",
    `Only a coding agent ${what}. Register one from the project's Agents button, then ask it to.`,
  );
}

/**
 * One action, its input the tool's from `@devsync/schemas`: `answer` gives the domain's value,
 * and a `DevSyncError` it throws becomes the result `{ refused }`. A `start` adds `confirm` to an
 * answer that isn't a refusal.
 */
function action<N extends McpToolName>(
  name: N,
  kind: DevSyncAction["kind"],
  description: string,
  answer: (
    ctx: DevSyncActionContext,
    input: z.output<(typeof MCP_TOOL_INPUTS)[N]>,
  ) => Promise<unknown>,
  confirm?: { label: string },
): DevSyncAction<(typeof MCP_TOOL_INPUTS)[N]> {
  return {
    name,
    kind,
    description,
    input: MCP_TOOL_INPUTS[name],
    run: async (ctx, input) => {
      try {
        const result = await answer(ctx, input);
        return confirm ? { result, confirm } : { result };
      } catch (error) {
        if (!(error instanceof DevSyncError)) throw error;
        const refused: Refused = { refused: { code: error.code, message: error.message } };
        return { result: refused };
      }
    },
  };
}

const R = ACTION_RULES;

/** DevSync's actions, in the order its own endpoint lists them. */
// biome-ignore lint/suspicious/noExplicitAny: each action types its own input, as the contract's list.
export const actions: readonly DevSyncAction<any>[] = [
  action(
    "get_project_state",
    "read",
    `Read the project, its agents, and its 100 most recently updated tasks with their requirements. ${R.start}`,
    async (ctx) => agentProjectState(ctx.host, await reader(ctx)),
  ),
  action(
    "list_tasks",
    "read",
    "List the project's tasks, most recently updated first, by `status` and by `assignee`: `none`, a member's user id, or `me` for the member asking.",
    async (ctx, query) => listTasks(ctx.host, await reader(ctx), query),
  ),
  action(
    "get_task",
    "read",
    "Read one task: its requirements with their revisions, its comments and timeline, its linked pull request, and its latest managed run.",
    async (ctx, { taskId }) => {
      const read = await reader(ctx);
      const task = await getTask(ctx.host, read, taskId);
      const { runs } = await listRuns(ctx.host, read, task.id);
      return { task, latestRun: runs[0] ?? null };
    },
  ),
  action(
    "get_pending_signals",
    "read",
    `Read your oldest unacknowledged signals: messages from members and peer agents, review requests, and the repository's pushes and pull requests. ${R.start}`,
    async (ctx) => pendingSignals(ctx.host, await agentOnly(ctx, "reads its signals")),
  ),
  action(
    "acknowledge_signal",
    "write",
    "Acknowledge an inbox signal once it has been processed.",
    async (ctx, { id }) =>
      acknowledgeSignal(ctx.host, await agentOnly(ctx, "acknowledges its signals"), id),
  ),
  action(
    "claim_task",
    "write",
    `Claim a Ready task, or recover one whose claim expired, for 15 minutes. ${R.claim} ${R.renew} ${R.recall} Generate a new UUID for each claim attempt and reuse it only when retrying the same request.`,
    async (ctx, input) => claimTask(ctx.host, await agentOnly(ctx, "claims a task"), input),
  ),
  action(
    "renew_task_claim",
    "write",
    `Renew your current claim for 15 minutes from now. ${R.renew} The result includes the latest requirements revision: when it changed, read the task again.`,
    async (ctx, input) => renewTaskClaim(ctx.host, await agentOnly(ctx, "renews a claim"), input),
  ),
  action(
    "release_task",
    "write",
    "Release your current claim and return the task to Ready.",
    async (ctx, input) => releaseTask(ctx.host, await agentOnly(ctx, "releases a claim"), input),
  ),
  action(
    "publish_signal",
    "write",
    "Send a message to another agent in this project. When responding to an inbox signal, provide its ID as replyToId. Reuse the idempotency key only to retry the same message.",
    async (ctx, input) =>
      publishAgentSignal(ctx.host, await agentOnly(ctx, "sends signals to its peers"), input),
  ),
  action(
    "create_task",
    "write",
    "Create a Backlog task in the project. Supply a new request UUID and reuse it when retrying the same task.",
    async (ctx, input) => createTask(ctx.host, await writer(ctx), input),
  ),
  action(
    "update_task",
    "write",
    "Edit a task's requirements, or move it to Backlog or Ready; an agent edits only the tasks it created. Supply the current task version. Move a Backlog task to Ready to make it claimable.",
    async (ctx, { taskId, ...fields }) => updateTask(ctx.host, await writer(ctx), taskId, fields),
  ),
  action(
    "report_progress",
    "write",
    `Record progress under your active claim and the current requirements revision. ${R.blocker}`,
    async (ctx, input) => reportProgress(ctx.host, await agentOnly(ctx, "reports progress"), input),
  ),
  action(
    "report_blocker",
    "write",
    `Record a blocker, move the task to Blocked, and end your claim. ${R.blocker} A member makes the task Ready again once it is unblocked.`,
    async (ctx, input) => reportBlocker(ctx.host, await agentOnly(ctx, "reports a blocker"), input),
  ),
  action(
    "request_review",
    "write",
    `Record a review request, move the task to Review, and end your claim. ${R.review} ${R.remember} A peer agent reviews it, and a member marks it done.`,
    async (ctx, input) => requestReview(ctx.host, await agentOnly(ctx, "requests a review"), input),
  ),
  action(
    "submit_review",
    "write",
    "Record a peer review decision for the current review request and requirements revision. Use the reviewRequestId from the review signal. Approval leaves final completion to a human.",
    async (ctx, input) => submitReview(ctx.host, await agentOnly(ctx, "submits a review"), input),
  ),
  action(
    "request_run",
    "start",
    "Propose a managed run of a Ready task: the project's own GitHub Actions run a coding agent on its current requirements and open a draft pull request. This checks the task and the repository's setup, and answers the task and the revision a run would take; nothing starts here. The member then asks for the run from the task's runs section in DevSync's tab, and an Owner, Admin or Approver approves it.",
    async (ctx, { taskId }) => {
      const member = memberOf(ctx);
      if (member) return checkRunRequest(ctx.host, member, taskId);
      if (ctx.caller.kind === "run") throw runReadsOnly();
      throw new DevSyncError(
        "forbidden",
        "Only a member can ask for a managed run. Ask one to do it from the task's runs section in DevSync's tab.",
      );
    },
    { label: "Ask for a managed run" },
  ),
];
