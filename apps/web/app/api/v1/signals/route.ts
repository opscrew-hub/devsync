import { api, projectId } from "@/lib/api";
import { listSignals, publishSignal } from "@devsync/core/agent-signals";

export const GET = (request: Request) => api(request, (userId, url) => listSignals(userId, projectId(url)));
export const POST = (request: Request) => api(request, async (userId, url) => publishSignal(userId, projectId(url), await request.json()), 201);
