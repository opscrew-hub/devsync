/**
 * The public routes, mounted by the host at `/m/devsync` with no session: `POST /mcp`, the coding
 * agents' MCP endpoint (docs/host.md, MCP for coding agents).
 * Stateless Streamable HTTP with JSON answers: each request is authenticated by its bearer token
 * (which also checks DevSync is still on for the agent's project), then answered by a fresh MCP
 * server whose tools call the domain as that agent.
 */

import { MCP_TOOL_INPUTS } from "@devsync/schemas";
import {
  type CallToolResult,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { reportBlocker, reportProgress, requestReview, submitReview } from "../domain/activity";
import { authenticateAgent } from "../domain/agents";
import { claimTask, releaseTask, renewTaskClaim } from "../domain/claims";
import {
  acknowledgeSignal,
  agentProjectState,
  pendingSignals,
  publishAgentSignal,
} from "../domain/signals";
import { createTask, updateTask } from "../domain/tasks";
import { type AgentActor, DevSyncError, type DevSyncHost, ERROR_STATUS } from "../host";
import { describeError, errorHandler, INTERNAL_MESSAGE, noStore, refusalBody } from "./errors";

const FOREIGN_ORIGIN =
  "This request's origin isn't DevSync's, so it was refused. Connect your agent to the MCP endpoint directly, not from a web page.";

/** A refusal before the MCP server runs: an agent's client reads `WWW-Authenticate` on a 401. */
function refuse(c: Context, error: DevSyncError): Response {
  const headers: Record<string, string> =
    error.code === "unauthenticated" ? { "WWW-Authenticate": "Bearer" } : {};
  return c.json(refusalBody(error), ERROR_STATUS[error.code], headers);
}

/**
 * A tool's answer: the domain's value as JSON text, a `DevSyncError` as the tool's error, and
 * anything else logged and answered without its details (the SDK would answer its message).
 */
async function result(
  host: DevSyncHost,
  tool: string,
  run: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run()) }] };
  } catch (error) {
    if (error instanceof DevSyncError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    host.log.error(`DevSync's MCP tool ${tool} failed: ${describeError(error)}`);
    return { isError: true, content: [{ type: "text", text: INTERNAL_MESSAGE }] };
  }
}

/** An MCP server for one request, its tools acting as `actor`. */
function mcpServer(host: DevSyncHost, actor: AgentActor): McpServer {
  const server = new McpServer({ name: "devsync", version: "0.1.0" });
  const inputs = MCP_TOOL_INPUTS;

  server.registerTool(
    "get_project_state",
    {
      description: "Read the assigned project and its 100 most recently updated tasks.",
      inputSchema: inputs.get_project_state,
    },
    () => result(host, "get_project_state", () => agentProjectState(host, actor)),
  );
  server.registerTool(
    "get_pending_signals",
    {
      description: "Read your oldest unacknowledged signals.",
      inputSchema: inputs.get_pending_signals,
    },
    () => result(host, "get_pending_signals", () => pendingSignals(host, actor)),
  );
  server.registerTool(
    "acknowledge_signal",
    {
      description: "Acknowledge an inbox signal once it has been processed.",
      inputSchema: inputs.acknowledge_signal,
    },
    ({ id }) => result(host, "acknowledge_signal", () => acknowledgeSignal(host, actor, id)),
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Claim a ready task or recover an expired claim for 15 minutes. Generate a new UUID for each claim attempt and reuse it only when retrying the same request.",
      inputSchema: inputs.claim_task,
    },
    (input) => result(host, "claim_task", () => claimTask(host, actor, input)),
  );
  server.registerTool(
    "renew_task_claim",
    {
      description:
        "Renew your current claim before it expires. The result includes the latest requirements revision.",
      inputSchema: inputs.renew_task_claim,
    },
    (input) => result(host, "renew_task_claim", () => renewTaskClaim(host, actor, input)),
  );
  server.registerTool(
    "release_task",
    {
      description: "Release your current claim and return the task to Ready.",
      inputSchema: inputs.release_task,
    },
    (input) => result(host, "release_task", () => releaseTask(host, actor, input)),
  );

  server.registerTool(
    "publish_signal",
    {
      description:
        "Send a message to another agent in this project. When responding to an inbox signal, provide its ID as replyToId. Reuse the idempotency key only to retry the same message.",
      inputSchema: inputs.publish_signal,
    },
    (input) => result(host, "publish_signal", () => publishAgentSignal(host, actor, input)),
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Create a Backlog task in your project. Supply a new request UUID and reuse it when retrying the same task.",
      inputSchema: inputs.create_task,
    },
    (input) => result(host, "create_task", () => createTask(host, actor, input)),
  );
  server.registerTool(
    "update_task",
    {
      description:
        "Edit a task you created. Supply the current task version. Move a Backlog task to Ready to make it claimable.",
      inputSchema: inputs.update_task,
    },
    ({ taskId, ...fields }) =>
      result(host, "update_task", () => updateTask(host, actor, taskId, fields)),
  );

  server.registerTool(
    "report_progress",
    {
      description: "Record progress under your active claim and current requirements revision.",
      inputSchema: inputs.report_progress,
    },
    (input) => result(host, "report_progress", () => reportProgress(host, actor, input)),
  );
  server.registerTool(
    "report_blocker",
    {
      description: "Record a blocker, move the task to Blocked, and end your claim.",
      inputSchema: inputs.report_blocker,
    },
    (input) => result(host, "report_blocker", () => reportBlocker(host, actor, input)),
  );
  server.registerTool(
    "request_review",
    {
      description: "Record a review request, move the task to Review, and end your claim.",
      inputSchema: inputs.request_review,
    },
    (input) => result(host, "request_review", () => requestReview(host, actor, input)),
  );

  server.registerTool(
    "submit_review",
    {
      description:
        "Record a peer review decision for the current review request and requirements revision. Use the reviewRequestId from the review signal. Approval leaves final completion to a human.",
      inputSchema: inputs.submit_review,
    },
    (input) => result(host, "submit_review", () => submitReview(host, actor, input)),
  );

  return server;
}

export function publicRoutes(host: DevSyncHost): Hono {
  const app = new Hono();
  app.onError(errorHandler(host));
  app.use(noStore);

  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return refuse(c, new DevSyncError("forbidden", FOREIGN_ORIGIN));
    }
    const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    let actor: AgentActor;
    try {
      actor = await authenticateAgent(host, token);
    } catch (error) {
      if (error instanceof DevSyncError) return refuse(c, error);
      throw error;
    }

    const server = mcpServer(host, actor);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  const postOnly = (c: Context) => c.body(null, 405, { Allow: "POST" });
  app.get("/mcp", postOnly);
  app.delete("/mcp", postOnly);

  return app;
}
