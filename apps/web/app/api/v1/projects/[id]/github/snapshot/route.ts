import { api } from "@/lib/api";
import { refreshGithubSnapshot } from "@devsync/core/github-app";
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async userId => refreshGithubSnapshot(userId, (await params).id));
}
