import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createAgentTask, DomainError, updateAgentTask } from "@devsync/core";
import { authenticateAgent, acknowledgeSignal, pendingSignals, agentProjectState, publishAgentSignal } from "@devsync/core/agent-signals";
import { claimTask, renewTaskClaim, releaseTaskClaim } from "@devsync/core/task-claims";
import { agentSignalInput, agentTaskInput, agentTaskUpdate, taskActivityInput } from "@devsync/contracts";
import { reportTaskActivity } from "@devsync/core/task-activity";
import { z } from "zod";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  try {
    await authenticateAgent(token);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return Response.json({ error: error.message }, {
      status: error.status,
      headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
    });
  }

  const server = new McpServer({ name: "devsync", version: "0.1.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  async function result(run: () => Promise<unknown>) {
    try {
      const data = await run();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { isError: true, content: [{ type: "text" as const, text: error.message }] };
    }
  }
  server.registerTool("get_project_state", {
    description: "Read the assigned project and its 100 most recently updated tasks.",
    inputSchema: z.object({}),
  }, () => result(() => agentProjectState(token)));
  server.registerTool("get_pending_signals", {
    description: "Read your oldest unacknowledged signals.",
    inputSchema: z.object({}),
  }, () => result(() => pendingSignals(token)));
  server.registerTool("acknowledge_signal", {
    description: "Acknowledge an inbox signal once it has been processed.",
    inputSchema: z.object({ id: z.string().min(1).max(40) }),
  }, ({ id }) => result(() => acknowledgeSignal(token, id)));

  const claimInput = z.object({ taskId: z.string().min(1).max(40), claimId: z.uuid() });
  server.registerTool("claim_task", {
    description: "Claim a ready task or recover an expired claim for 15 minutes. Generate a new UUID for each claim attempt and reuse it only when retrying the same request.",
    inputSchema: claimInput,
  }, ({ taskId, claimId }) => result(() => claimTask(token, taskId, claimId)));
  server.registerTool("renew_task_claim", {
    description: "Renew your current claim before it expires. The result includes the latest requirements revision.",
    inputSchema: claimInput,
  }, ({ taskId, claimId }) => result(() => renewTaskClaim(token, taskId, claimId)));
  server.registerTool("release_task", {
    description: "Release your current claim and return the task to Ready.",
    inputSchema: claimInput,
  }, ({ taskId, claimId }) => result(() => releaseTaskClaim(token, taskId, claimId)));

  server.registerTool("publish_signal", {
    description: "Send a message to another agent in this project. When responding to an inbox signal, provide its ID as replyToId. Reuse the idempotency key only to retry the same message.",
    inputSchema: agentSignalInput,
  }, input => result(() => publishAgentSignal(token, input)));

  server.registerTool("create_task", {
    description: "Create a Backlog task in your project. Supply a new request UUID and reuse it when retrying the same task.",
    inputSchema: agentTaskInput,
  }, input => result(() => createAgentTask(token, input)));
  server.registerTool("update_task", {
    description: "Edit a task you created. Supply the current task version. Move a Backlog task to Ready to make it claimable.",
    inputSchema: agentTaskUpdate.extend({ taskId: z.string().min(1).max(40) }),
  }, ({ taskId, ...input }) => result(() => updateAgentTask(token, taskId, input)));

  server.registerTool("report_progress", {
    description: "Record progress under your active claim and current requirements revision.",
    inputSchema: taskActivityInput,
  }, input => result(() => reportTaskActivity(token, "implementation.progress", input)));
  server.registerTool("report_blocker", {
    description: "Record a blocker, move the task to Blocked, and end your claim.",
    inputSchema: taskActivityInput,
  }, input => result(() => reportTaskActivity(token, "task.blocked", input)));
  server.registerTool("request_review", {
    description: "Record a review request, move the task to Review, and end your claim.",
    inputSchema: taskActivityInput,
  }, input => result(() => reportTaskActivity(token, "review.requested", input)));

  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    await server.close();
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export const DELETE = GET;
