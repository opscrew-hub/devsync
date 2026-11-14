/**
 * Agents: registration, tokens and authentication (docs/host.md, MCP for coding agents), legacy's
 * `agent-signals.ts`. An Owner or Admin registers an agent for a project; its bearer token is shown
 * once and DevSync keeps only its SHA-256. A token lasts 24 hours and can be rotated or revoked.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type Agent,
  AgentInput,
  type AgentList,
  type AgentWithToken,
  can,
  Id,
} from "@devsync/schemas";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { z } from "zod";
import { type AgentRow, agent } from "../db";
import {
  type AgentActor,
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type ProjectContext,
} from "../host";

/** How long a token lasts from its registration or rotation. */
export const AGENT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Seen within this long: "Recently active" (legacy's two minutes). */
const RECENTLY_ACTIVE_MS = 2 * 60 * 1000;
/** 32 random bytes, base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const UNAUTHENTICATED =
  "The token is invalid, expired or revoked, or DevSync is off for its project. Ask an Owner or Admin for a new one.";
const NO_SUCH_AGENT = "There's no such agent in this project. Reload the agents list.";

/**
 * Parses `input` with `schema`, refusing it as `invalid` with the fields' names (never values): the
 * agents' domain's inputs (agents, signals, claims, activity).
 */
export function parseOrRefuse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "body"))];
  throw new DevSyncError(
    "invalid",
    `Check ${fields.length === 1 ? "this field" : "these fields"} and try again: ${fields.join(", ")}.`,
    fields,
  );
}

/** Refuses an agent's write to a read-only project (past its workspace's plan). */
export function requireAgentWrite(actor: AgentActor): void {
  if (actor.project.readOnly) {
    throw new DevSyncError(
      "forbidden",
      "This project is read-only because its workspace is past its plan: agents can read it but not change it. Ask an Owner to upgrade the plan.",
    );
  }
}

/**
 * Locks the agent's row in `tx` (`FOR NO KEY UPDATE`), so one agent's idempotent writes and its
 * signal limits are checked one at a time, as legacy does.
 */
export async function lockAgentRow(tx: DevSyncDb, actor: AgentActor): Promise<void> {
  const [row] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, actor.agentId), eq(agent.projectId, actor.project.projectId)))
    .for("no key update");
  if (!row) throw new DevSyncError("unauthenticated", UNAUTHENTICATED);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requireManage(ctx: ProjectContext): void {
  if (!can(ctx.member.role, "agent.manage")) {
    throw new DevSyncError(
      "forbidden",
      "Only an Owner or Admin can register, rotate or revoke agents. Ask one of them.",
    );
  }
}

/** An agent id from a path: anything but a UUID is no agent of the project's. */
function agentIdOf(agentId: string): string {
  if (!Id.safeParse(agentId).success) throw new DevSyncError("not-found", NO_SUCH_AGENT);
  return agentId;
}

function inProject(ctx: ProjectContext, agentId: string) {
  return and(eq(agent.id, agentIdOf(agentId)), eq(agent.projectId, ctx.project.projectId));
}

function toAgent(row: AgentRow, now: Date): Agent {
  const at = now.getTime();
  const status: Agent["status"] = row.revokedAt
    ? "Revoked"
    : row.expiresAt.getTime() <= at
      ? "Expired"
      : row.lastSeenAt && at - row.lastSeenAt.getTime() < RECENTLY_ACTIVE_MS
        ? "Recently active"
        : "Offline";
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status,
    expiresAt: row.expiresAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A fresh token and what DevSync keeps of it. */
function newToken(now: Date) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + AGENT_TOKEN_LIFETIME_MS),
  };
}

function audit(
  host: DevSyncHost,
  tx: DevSyncDb,
  ctx: ProjectContext,
  action: "devsync.agent.registered" | "devsync.agent.rotated" | "devsync.agent.revoked",
  row: AgentRow,
): Promise<void> {
  return host.audit(
    tx,
    { userId: ctx.member.userId },
    {
      workspaceId: ctx.project.workspaceId,
      projectId: ctx.project.projectId,
      action,
      detail: { agentId: row.id, name: row.name, kind: row.kind },
    },
  );
}

/** `POST /agents` (`agent.manage`): the agent, and its token, shown once. */
export async function registerAgent(
  host: DevSyncHost,
  ctx: ProjectContext,
  input: AgentInput,
): Promise<AgentWithToken> {
  requireManage(ctx);
  const fields = parseOrRefuse(AgentInput, input);
  const now = host.clock.now();
  const { token, tokenHash, expiresAt } = newToken(now);
  const row = await host.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(agent)
      .values({
        workspaceId: ctx.project.workspaceId,
        projectId: ctx.project.projectId,
        name: fields.name,
        kind: fields.kind,
        tokenHash,
        expiresAt,
        registeredByUserId: ctx.member.userId,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("The agent wasn't saved.");
    await audit(host, tx, ctx, "devsync.agent.registered", created);
    return created;
  });
  return { agent: toAgent(row, now), token };
}

/**
 * `POST /agents/:agentId/rotate` (`agent.manage`): a new token for 24 hours from now; the old one
 * stops working. As in legacy, it revives a revoked agent and keeps its inbox.
 */
export async function rotateAgent(
  host: DevSyncHost,
  ctx: ProjectContext,
  agentId: string,
): Promise<AgentWithToken> {
  requireManage(ctx);
  const where = inProject(ctx, agentId);
  const now = host.clock.now();
  const { token, tokenHash, expiresAt } = newToken(now);
  const row = await host.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agent)
      .set({ tokenHash, expiresAt, revokedAt: null, lastSeenAt: null })
      .where(where)
      .returning();
    if (!updated) throw new DevSyncError("not-found", NO_SUCH_AGENT);
    await audit(host, tx, ctx, "devsync.agent.rotated", updated);
    return updated;
  });
  return { agent: toAgent(row, now), token };
}

/**
 * `DELETE /agents/:agentId` (`agent.manage`): its token is refused from now on. Revoking a revoked
 * agent changes nothing (and isn't audited again).
 */
export async function revokeAgent(
  host: DevSyncHost,
  ctx: ProjectContext,
  agentId: string,
): Promise<void> {
  requireManage(ctx);
  const where = inProject(ctx, agentId);
  const now = host.clock.now();
  await host.db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(agent)
      .set({ revokedAt: now })
      .where(and(where, isNull(agent.revokedAt)))
      .returning();
    if (revoked) return audit(host, tx, ctx, "devsync.agent.revoked", revoked);
    const [found] = await tx.select({ id: agent.id }).from(agent).where(where);
    if (!found) throw new DevSyncError("not-found", NO_SUCH_AGENT);
  });
}

/** `GET /agents`: the project's agents, newest first, with legacy's statuses. */
export async function listAgents(host: DevSyncHost, ctx: ProjectContext): Promise<AgentList> {
  const now = host.clock.now();
  const rows = await host.db
    .select()
    .from(agent)
    .where(eq(agent.projectId, ctx.project.projectId))
    .orderBy(desc(agent.createdAt), desc(agent.id));
  return { agents: rows.map((row) => toAgent(row, now)) };
}

/**
 * The agent a bearer token belongs to, and its project as the host answers it now: refused alike
 * (`unauthenticated`) when the token is malformed, unknown, expired or revoked, or when DevSync is
 * off for its project. Records when the agent was last seen.
 */
export async function authenticateAgent(host: DevSyncHost, token: string): Promise<AgentActor> {
  const refused = () => new DevSyncError("unauthenticated", UNAUTHENTICATED);
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) throw refused();
  const now = host.clock.now();
  const live = and(
    eq(agent.tokenHash, hashToken(token)),
    isNull(agent.revokedAt),
    gt(agent.expiresAt, now),
  );
  const [found] = await host.db
    .select({ id: agent.id, workspaceId: agent.workspaceId, projectId: agent.projectId })
    .from(agent)
    .where(live);
  if (!found) throw refused();
  const project = await host.project(found.projectId);
  if (
    !project ||
    project.projectId !== found.projectId ||
    project.workspaceId !== found.workspaceId
  ) {
    throw refused();
  }
  const [seen] = await host.db
    .update(agent)
    .set({ lastSeenAt: now })
    .where(and(eq(agent.id, found.id), live))
    .returning({ id: agent.id, name: agent.name });
  if (!seen) throw refused();
  return { kind: "agent", agentId: seen.id, name: seen.name, project };
}
