import { auth } from "@/auth";
import { DomainError } from "@devsync/core";
import pino from "pino";
const logger = pino({ name: "devsync-web" });
export async function api(request: Request, run: (userId: string, url: URL) => Promise<unknown>, status = 200) {
  try {
    const userId = (await auth())?.userId;
    if (!userId) throw new DomainError(401, "Sign in to continue.");
    const url = new URL(request.url);
    if (request.method !== "GET" && request.headers.get("origin") !== url.origin) throw new DomainError(403, "Invalid request origin.");
    return Response.json({ data: await run(userId, url) }, { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) return Response.json({ error: "Invalid request data." }, { status: 400 });
    logger.error({ errorType: error instanceof Error ? error.name : "unknown" }, "API request failed");
    return Response.json({ error: "Request failed." }, { status: 500 });
  }
}
export function projectId(url: URL) {
  const id = url.searchParams.get("projectId");
  if (!id) throw new DomainError(400, "Project ID is required.");
  return id;
}
