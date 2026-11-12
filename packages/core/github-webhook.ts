import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@devsync/db";
import { githubWebhookEnvelope } from "@devsync/contracts";
import { DomainError } from "./index.ts";

const supportedEvents = new Set(["push", "pull_request", "pull_request_review", "check_run", "check_suite", "workflow_run"]);
const maxBytes = 2 * 1024 * 1024;

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new DomainError(413, "Webhook is too large.");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new DomainError(413, "Webhook is too large.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object") return true;
  return depth < 32 && Object.values(value).every(child => isBoundedJson(child, depth + 1));
}

export async function receiveGithubWebhook(request: Request, secret: string, repositories: ReadonlySet<string>) {
  const signature = request.headers.get("x-hub-signature-256");
  const hex = signature?.match(/^sha256=([a-f0-9]{64})$/)?.[1];
  if (!hex) throw new DomainError(401, "Invalid webhook signature.");
  const body = await readBody(request);
  const expected = createHmac("sha256", secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(hex, "hex"))) throw new DomainError(401, "Invalid webhook signature.");

  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery")?.toLowerCase() ?? "";
  if (!/^[a-z_]{1,40}$/.test(event) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deliveryId)) {
    throw new DomainError(400, "Invalid webhook metadata.");
  }
  if (event === "ping" || !supportedEvents.has(event)) return { status: "ignored" as const };
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new DomainError(415, "Expected a JSON webhook.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new DomainError(400, "Invalid webhook JSON.");
  }
  if (!isBoundedJson(payload)) throw new DomainError(400, "Webhook JSON exceeds supported limits.");
  const envelope = githubWebhookEnvelope.safeParse(payload);
  if (!envelope.success) throw new DomainError(400, "Webhook repository or installation ID is missing.");
  const installationId = envelope.data.installation.id;
  const repositoryId = envelope.data.repository.id;
  if (!repositories.has(`${installationId}:${repositoryId}`)) throw new DomainError(403, "Repository is not enabled for webhooks.");
  const saved = await db.githubEvent.createMany({
    data: { deliveryId, event, installationId: BigInt(installationId), repositoryId: BigInt(repositoryId), payload: envelope.data },
    skipDuplicates: true,
  });
  return { status: saved.count ? "accepted" as const : "duplicate" as const };
}
