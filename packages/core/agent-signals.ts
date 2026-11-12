import { createHash, randomBytes } from "node:crypto";
import { db } from "@devsync/db";
import { agentInput, signalInput } from "@devsync/contracts";
import { DomainError, requireProject } from "./index.ts";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const agentFields = { id: true, name: true, type: true, lastHeartbeat: true, expiresAt: true, revokedAt: true } as const;

export async function registerAgent(userId: string, projectId: string, input: unknown) {
  const member = await requireProject(userId, projectId);
  if (member.role !== "OWNER") throw new DomainError(403, "Only project owners can register agents.");
  const fields = agentInput.parse(input);
  const token = randomBytes(32).toString("base64url");
  const agent = await db.agent.create({
    data: { ...fields, projectId, credentialHash: digest(token), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    select: agentFields,
  });
  return { agent, token };
}

export async function listAgents(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  const agents = await db.agent.findMany({ where: { projectId }, select: agentFields, orderBy: { createdAt: "desc" } });
  const now = Date.now();
  return agents.map(agent => ({
    ...agent,
    status: agent.revokedAt ? "Revoked" : agent.expiresAt.getTime() <= now ? "Expired" :
      agent.lastHeartbeat && now - agent.lastHeartbeat.getTime() < 120000 ? "Recently active" : "Offline",
  }));
}

export async function revokeAgent(userId: string, projectId: string, agentId: string) {
  const member = await requireProject(userId, projectId);
  if (member.role !== "OWNER") throw new DomainError(403, "Only project owners can revoke agents.");
  await db.agent.updateMany({ where: { id: agentId, projectId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function publishSignal(userId: string, projectId: string, input: unknown) {
  await requireProject(userId, projectId, true);
  const fields = signalInput.parse(input);
  const recipient = await db.agent.findUnique({ where: { projectId_id: { projectId, id: fields.recipientId } } });
  if (!recipient || recipient.revokedAt) throw new DomainError(404, "Agent not found.");
  const signal = await db.signal.upsert({
    where: { projectId_senderId_idempotencyKey: { projectId, senderId: userId, idempotencyKey: fields.idempotencyKey } },
    create: { ...fields, projectId, senderId: userId },
    update: {},
  });
  if (signal.recipientId !== fields.recipientId || signal.kind !== fields.kind ||
    typeof signal.payload !== "object" || !signal.payload || !("message" in signal.payload) ||
    signal.payload.message !== fields.payload.message) {
    throw new DomainError(409, "Idempotency key already used for another signal.");
  }
  return signal;
}

export async function listSignals(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return db.signal.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function authenticateAgent(token: string) {
  if (!/^[\w-]{43}$/.test(token)) throw new DomainError(401, "Invalid agent credential.");
  const now = new Date();
  const agent = await db.agent.updateManyAndReturn({
    where: { credentialHash: digest(token), revokedAt: null, expiresAt: { gt: now } },
    data: { lastHeartbeat: now },
    select: { id: true, projectId: true },
  });
  if (!agent[0]) throw new DomainError(401, "Invalid agent credential.");
  return agent[0];
}

export async function pendingSignals(token: string) {
  const agent = await authenticateAgent(token);
  return db.signal.findMany({
    where: { projectId: agent.projectId, recipientId: agent.id, acknowledgedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
}

export async function acknowledgeSignal(token: string, id: string) {
  const agent = await authenticateAgent(token);
  const where = { id, projectId: agent.projectId, recipientId: agent.id };
  await db.signal.updateMany({ where: { ...where, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
  if (!await db.signal.findFirst({ where, select: { id: true } })) throw new DomainError(404, "Signal not found.");
  return { id, acknowledged: true };
}

export async function agentProjectState(token: string) {
  const { projectId } = await authenticateAgent(token);
  return db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      description: true,
      tasks: { orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100 },
    },
  });
}

export async function rotateAgentCredential(userId: string, projectId: string, agentId: string) {
  const member = await requireProject(userId, projectId);
  if (member.role !== "OWNER") throw new DomainError(403, "Only project owners can rotate credentials.");
  const token = randomBytes(32).toString("base64url");
  const updated = await db.agent.updateMany({
    where: { id: agentId, projectId },
    data: {
      credentialHash: digest(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      revokedAt: null,
      lastHeartbeat: null,
    },
  });
  if (!updated.count) throw new DomainError(404, "Agent not found.");
  return { token };
}
