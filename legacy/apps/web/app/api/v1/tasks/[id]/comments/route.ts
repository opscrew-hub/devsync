import { api, projectId } from "@/lib/api";
import { createTaskComment } from "@devsync/core";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, { params }: Context) {
  return api(request, async (userId, url) => {
    const { id } = await params;
    return createTaskComment(userId, projectId(url), id, await request.json());
  }, 201);
}
