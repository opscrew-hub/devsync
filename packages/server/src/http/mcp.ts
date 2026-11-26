/**
 * The public routes, mounted by the host at `/m/devsync` with no session: `POST /mcp`, the coding
 * agents' MCP endpoint (docs/host.md, MCP for coding agents), kept until a later release while
 * agents move to the host's `/mcp`.
 * Stateless Streamable HTTP with JSON answers: each request is authenticated by its bearer token
 * (which also checks DevSync is still on for the agent's project), then answered by a fresh MCP
 * server whose tools are DevSync's actions (actions.ts), called as that agent, so this endpoint
 * and the host's `/mcp` never differ. Its tools keep their names, without the host's `devsync_`.
 * Before a token is verified, a rate limit (rate-limit.ts): 120 requests a minute per token seen
 * valid before, and 20 a minute per client for every other request, a missing or bad token's.
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
import { clientOf, MCP_RATE, TokenBuckets } from "./rate-limit";

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

/** A request past its limit: answered 429 with `Retry-After`, its token unverified. */
function rateLimited(c: Context, byToken: boolean, wait: number): Response {
  const message = byToken
    ? `This agent sent ${MCP_RATE.perToken} requests to DevSync's MCP endpoint in the last minute, the most it may. Try again in ${seconds(wait)}.`
    : `Too many requests without a valid token came from this address in the last minute. Check the agent's token, then try again in ${seconds(wait)}.`;
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
  const now = () => host.clock.now().getTime();
  // By the SHA-256 of a token seen valid before, and by client for every other request.
  const tokens = new TokenBuckets(MCP_RATE.perToken, now);
  const clients = new TokenBuckets(MCP_RATE.perClient, now);

  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return refuse(c, new DevSyncError("forbidden", FOREIGN_ORIGIN));
    }
    const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    // A token seen valid before takes from its own bucket; any other request waits for its
    // client's, which each refusal below takes from.
    const key = token === "" ? null : hashToken(token);
    const known = key !== null && tokens.has(key);
    const client = clientOf((name) => c.req.header(name));
    const wait = known ? tokens.take(key) : clients.wait(client);
    if (wait > 0) return rateLimited(c, known, wait);
    let actor: AgentActor;
    try {
      actor = await authenticateAgent(host, token);
    } catch (error) {
      if (!(error instanceof DevSyncError)) throw error;
      clients.take(client);
      return refuse(c, error);
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
