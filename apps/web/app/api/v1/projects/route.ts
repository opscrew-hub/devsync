import { api } from "@/lib/api";
import { createProject, listProjects } from "@devsync/core";
export const GET = (request: Request) => api(request, listProjects);
export const POST = (request: Request) => api(request, async userId => createProject(userId, await request.json()), 201);
