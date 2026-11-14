import { api } from "@/lib/api";
import { listProjectAudit } from "@devsync/core";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, { params }: Context) {
  return api(request, async userId => listProjectAudit(userId, (await params).id));
}
