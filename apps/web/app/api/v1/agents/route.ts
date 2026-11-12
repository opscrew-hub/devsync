import { api, projectId } from "@/lib/api";
import { listAgents, registerAgent, revokeAgent, rotateAgentCredential } from "@devsync/core/agent-signals";

export const GET = (request: Request) => api(request, (userId, url) => listAgents(userId, projectId(url)));
export const POST = (request: Request) => api(request, async (userId, url) => registerAgent(userId, projectId(url), await request.json()), 201);
export const DELETE = (request: Request) => api(request, async (userId, url) => {
  await revokeAgent(userId, projectId(url), url.searchParams.get("agentId") ?? "");
  return { revoked: true };
});
export const PATCH = (request: Request) => api(request, (userId, url) => rotateAgentCredential(userId, projectId(url), url.searchParams.get("agentId") ?? ""));
