import { api } from "@/lib/api";
import { getGithubRepository, linkGithubRepository } from "@devsync/core/github-app";

type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, { params }: Context) =>
  api(request, async userId => getGithubRepository(userId, (await params).id));
export const PUT = (request: Request, { params }: Context) =>
  api(request, async userId => linkGithubRepository(userId, (await params).id, await request.json()));
