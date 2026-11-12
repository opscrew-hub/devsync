import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { DomainError } from "@devsync/core";
import { authenticateAgent, acknowledgeSignal, pendingSignals, agentProjectState } from "@devsync/core/agent-signals";
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
