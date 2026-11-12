import { api } from "@/lib/api";
import { listProjectMembers, changeProjectMember } from "@devsync/core";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, { params }: Context) {
  return api(request, async userId => listProjectMembers(userId, (await params).id));
}

export function PATCH(request: Request, { params }: Context) {
  return api(request, async userId => changeProjectMember(userId, (await params).id, await request.json()));
}
