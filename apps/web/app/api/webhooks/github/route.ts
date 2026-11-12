import { DomainError } from "@devsync/core";
import { receiveGithubWebhook } from "@devsync/core/github-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "GitHub webhook is not configured." }, { status: 503 });
  const repositories = new Set((process.env.GITHUB_WEBHOOK_REPOSITORIES ?? "").split(",").map(pair => pair.trim()).filter(Boolean));
  try {
    const { status } = await receiveGithubWebhook(request, secret, repositories);
    if (status === "ignored") return new Response(null, { status: 204 });
    return Response.json({ status }, { status: status === "accepted" ? 202 : 200 });
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
