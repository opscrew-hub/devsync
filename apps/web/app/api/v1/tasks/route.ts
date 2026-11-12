import { api, projectId } from "@/lib/api";
import { createTask, listTasks } from "@devsync/core";
export const GET = (request: Request) => api(request, (userId, url) => listTasks(userId, projectId(url)));
export const POST = (request: Request) => api(request, async (userId, url) => createTask(userId, projectId(url), await request.json()), 201);
