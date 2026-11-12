import { api, projectId } from "@/lib/api";
import { getTask, updateTask } from "@devsync/core";
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, { params }: Context) => api(request, async (userId, url) => getTask(userId, projectId(url), (await params).id));
export const PATCH = (request: Request, { params }: Context) => api(request, async (userId, url) => updateTask(userId, projectId(url), (await params).id, await request.json()));
