import { api, projectId } from "@/lib/api";
import { setTaskPullRequest } from "@devsync/core/github-events";

export function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async (userId, url) =>
    setTaskPullRequest(userId, projectId(url), (await params).id, await request.json()));
}
