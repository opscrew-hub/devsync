import { api, projectId } from "@/lib/api";
import { decideRun } from "@devsync/core/runs";
export function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async (user, url) => decideRun(user, projectId(url), (await params).id, await request.json()));
}
