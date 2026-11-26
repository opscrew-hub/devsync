/**
 * The public routes, mounted by the host at `/m/devsync` with no session: `POST /mcp`, the coding
 * agents' MCP endpoint (docs/host.md, MCP for coding agents), kept until a later release while
 * agents move to the host's `/mcp`.
 * Stateless Streamable HTTP with JSON answers: each request is authenticated by its bearer token
 * (which also checks DevSync is still on for the agent's project), then answered by a fresh MCP
 * server whose tools are DevSync's actions (actions.ts), called as that agent, so this endpoint
 * and the host's `/mcp` never differ. Its tools keep their names, without the host's `devsync_`.
 */

import {
  type CallToolResult,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { actions, isRefused, MCP_INSTRUCTIONS } from "../actions";
import { authenticateAgent } from "../domain/agents";
import {
  type AgentActor,
  type DevSyncAction,
  type DevSyncActionContext,
  DevSyncError,
  type DevSyncHost,
  ERROR_STATUS,
} from "../host";
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
 * A tool's answer: the action's result as JSON text, DevSync's refusal as the tool's error with its
 * message, and a fault logged and answered without its details (the SDK would answer its message).
 */
async function answer(
  host: DevSyncHost,
  // biome-ignore lint/suspicious/noExplicitAny: each action types its own input, as the contract's list.
  action: DevSyncAction<any>,
  ctx: DevSyncActionContext,
  input: unknown,
): Promise<CallToolResult> {
  try {
    const { result } = await action.run(ctx, input);
    if (isRefused(result)) {
      return { isError: true, content: [{ type: "text", text: result.refused.message }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    host.log.error(`DevSync's MCP tool ${action.name} failed: ${describeError(error)}`);
    return { isError: true, content: [{ type: "text", text: INTERNAL_MESSAGE }] };
  }
}

/** An MCP server for one request, its tools DevSync's actions, called as `actor`. */
function mcpServer(host: DevSyncHost, actor: AgentActor): McpServer {
  const server = new McpServer(
    { name: "devsync", version: "0.1.0" },
    { instructions: MCP_INSTRUCTIONS },
  );
  const ctx: DevSyncActionContext = {
    project: actor.project,
    caller: { kind: "agent", agentId: actor.agentId, name: actor.name },
    via: "mcp",
    host,
  };
  for (const action of actions) {
    server.registerTool(
      action.name,
      { description: action.description, inputSchema: action.input },
      (input: unknown) => answer(host, action, ctx, input),
    );
  }
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
