import { api, projectId } from "@/lib/api";
import { listRuns, requestRun } from "@devsync/core/runs";
export const GET = (request: Request) => api(request, (user, url) => listRuns(user, projectId(url)));
export const POST = (request: Request) => api(request, async (user, url) => requestRun(user, projectId(url), await request.json()), 201);
