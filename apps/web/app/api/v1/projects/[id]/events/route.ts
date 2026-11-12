import { auth } from "@/auth";
import { projectEventStream } from "@/lib/project-event-stream";
import { readProjectRealtimeVersion } from "@devsync/core/project-realtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = (await auth())?.userId;
  if (!userId) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  const { id } = await params;
  return projectEventStream(() => readProjectRealtimeVersion(userId, id), request.signal);
}
