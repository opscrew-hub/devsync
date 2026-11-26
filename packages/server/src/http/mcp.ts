/**
 * The public routes, mounted by the host at `/m/devsync` with no session: `POST /mcp`, the coding
 * agents' MCP endpoint (docs/host.md, MCP for coding agents), kept until a later release while
 * agents move to the host's `/mcp`.
 * Stateless Streamable HTTP with JSON answers: each request is authenticated by its bearer token
 * (which also checks DevSync is still on for the agent's project), then answered by a fresh MCP
 * server whose tools are DevSync's actions (actions.ts), called as that agent, so this endpoint
 * and the host's `/mcp` never differ. Its tools keep their names, without the host's `devsync_`.
 * Before a token seen valid is verified again, a rate limit (rate-limit.ts): 120 requests a minute
 * per token. A token not seen valid yet is verified as before.
 */

import {
  type CallToolResult,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { actions, isRefused, MCP_INSTRUCTIONS } from "../actions";
import { authenticateAgent, hashToken } from "../domain/agents";
import {
  type AgentActor,
  type DevSyncAction,
  type DevSyncActionContext,
  DevSyncError,
  type DevSyncHost,
  ERROR_STATUS,
} from "../host";
import { describeError, errorHandler, INTERNAL_MESSAGE, noStore, refusalBody } from "./errors";
import { TOKEN_REQUESTS_PER_MINUTE, TokenBuckets } from "./rate-limit";

const FOREIGN_ORIGIN =
  "This request's origin isn't DevSync's, so it was refused. Connect your agent to the MCP endpoint directly, not from a web page.";

/** A refusal before the MCP server runs: an agent's client reads `WWW-Authenticate` on a 401. */
function refuse(c: Context, error: DevSyncError, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> =
    error.code === "unauthenticated" ? { "WWW-Authenticate": "Bearer", ...extra } : extra;
  return c.json(refusalBody(error), ERROR_STATUS[error.code], headers);
}

/** "1 second", "3 seconds". */
const seconds = (n: number) => `${n} ${n === 1 ? "second" : "seconds"}`;

/** A token's request past its limit: answered 429 with `Retry-After`, the token unverified. */
function rateLimited(c: Context, wait: number): Response {
  const message = `This agent sent ${TOKEN_REQUESTS_PER_MINUTE} requests to DevSync's MCP endpoint in the last minute, the most it may. Try again in ${seconds(wait)}.`;
  return refuse(c, new DevSyncError("rate-limited", message), { "Retry-After": String(wait) });
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
  // By the SHA-256 of each token seen valid, never the token itself.
  const tokens = new TokenBuckets(TOKEN_REQUESTS_PER_MINUTE, () => host.clock.now().getTime());

  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return refuse(c, new DevSyncError("forbidden", FOREIGN_ORIGIN));
    }
    const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    // A token seen valid takes from its own bucket before it is verified again; any other is
    // verified as before, its first valid request then starting its bucket.
    const key = token === "" ? null : hashToken(token);
    const known = key !== null && tokens.has(key);
    if (known) {
      const wait = tokens.take(key);
      if (wait > 0) return rateLimited(c, wait);
    }
    let actor: AgentActor;
    try {
      actor = await authenticateAgent(host, token);
    } catch (error) {
      if (error instanceof DevSyncError) return refuse(c, error);
      throw error;
    }
    if (key !== null && !known) tokens.take(key);

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
