import { api, projectId } from "@/lib/api";
import { getRunPatch } from "@devsync/core/runs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await api(request, (userId, url) => getRunPatch(userId, projectId(url), id));
  if (!response.ok || new URL(request.url).searchParams.get("download") !== "1") return response;

  const { data } = await response.json() as { data: { patch: string } };
  return new Response(data.patch, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="devsync-run.patch"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
