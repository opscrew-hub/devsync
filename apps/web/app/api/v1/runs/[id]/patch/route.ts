import { api, projectId } from "@/lib/api";
import { getRunPatch } from "@devsync/core/runs";

export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async (userId, url) => getRunPatch(userId, projectId(url), (await params).id));
}
