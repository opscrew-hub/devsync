import { DomainError } from "@devsync/core";
import { acknowledgeSignal, pendingSignals } from "@devsync/core/agent-signals";

async function inbox(request: Request, acknowledge: boolean) {
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (acknowledge && !id) throw new DomainError(400, "Signal ID is required.");
    const data = id && acknowledge ? await acknowledgeSignal(token, id) : await pendingSignals(token);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = (request: Request) => inbox(request, false);
export const POST = (request: Request) => inbox(request, true);
