/**
 * Agents (docs/host.md, MCP for coding agents). The host registers a project's agents once for
 * every module, and rotates and revokes their tokens; DevSync keeps a row of each agent it has seen,
 * with the host's id, so its inbox, claims and timeline point at it. The agents DevSync registered
 * itself before the host had any move to the host with their tokens (`moveAgents`, the hourly
 * `devsync.agents-move`); until one has, its token is checked against DevSync's own row.
 */
import { createHash } from "node:crypto";
import { type Agent, type AgentKind, type AgentList, Id } from "@devsync/schemas";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { type AgentRow, agent } from "../db";
import {
  type AdoptedAgent,
  type AgentActor,
  type AgentRef,
  DevSyncError,
  type DevSyncHost,
  type ProjectContext,
} from "../host";
import { REFUSAL } from "./common";

/** Seen within this long: "Recently active" (two minutes). */
const RECENTLY_ACTIVE_MS = 2 * 60 * 1000;
/** DevSync's own tokens: 32 random bytes, base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What DevSync (and the host) keeps of a token: its SHA-256, as 64 hex characters. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** DevSync's kinds as the host names them, and back. */
export const HOST_KIND = {
  CLAUDE: "claude",
  CODEX: "codex",
  OTHER: "other",
} as const satisfies Record<AgentKind, AgentRef["kind"]>;
const KIND_OF = { claude: "CLAUDE", codex: "CODEX", other: "OTHER" } as const satisfies Record<
  AgentRef["kind"],
  AgentKind
>;

/** The host's `AgentRef`, checked before DevSync uses it. */
const HostAgent = z.object({
  agentId: Id,
  projectId: Id,
  workspaceId: Id,
  name: z.string().min(1),
  kind: z.enum(["claude", "codex", "other"]),
  modules: z.array(z.string()),
});

/**
 * The host's agent, parsed: an answer that doesn't parse is the host's fault, so it fails as
 * unexpected, its message naming fields only, never their values.
 */
function hostAgent(answer: unknown): AgentRef {
  const parsed = HostAgent.safeParse(answer);
  if (parsed.success) return parsed.data;
  const paths = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
  throw new Error(`The host's agent doesn't match DevSync's schema at ${paths.join(", ")}.`);
}

/** "Recently active" when seen within two minutes, else "Offline". */
function presence(seen: Date | null | undefined, now: Date): Agent["status"] {
  return seen && now.getTime() - seen.getTime() < RECENTLY_ACTIVE_MS
    ? "Recently active"
    : "Offline";
}

/** One of DevSync's own agents, not yet moved to the host. */
function ownAgent(row: AgentRow, now: Date): Agent {
  const status: Agent["status"] = row.revokedAt
    ? "Revoked"
    : row.expiresAt && row.expiresAt.getTime() <= now.getTime()
      ? "Expired"
      : presence(row.lastSeenAt, now);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One of the host's agents, with when DevSync's row of it (if it has one: the agent has connected)
 * was made and last seen. The host's list doesn't say which of its agents are revoked or expired;
 * DevSync's row says it of one DevSync revoked before its move.
 */
function hostsAgent(ref: AgentRef, row: AgentRow | undefined, now: Date): Agent {
  return {
    id: ref.agentId,
    name: ref.name,
    kind: KIND_OF[ref.kind],
    status: row?.revokedAt ? "Revoked" : presence(row?.lastSeenAt, now),
    expiresAt: null,
    lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
    createdAt: row?.createdAt.toISOString() ?? null,
  };
}

/**
 * `GET /agents`: the project's agents. The host's first (`host.agents.list`), in its order, then
 * DevSync's own not yet moved, newest first, with their statuses.
 */
export async function listAgents(host: DevSyncHost, ctx: ProjectContext): Promise<AgentList> {
  const { projectId, workspaceId } = ctx.project;
  const now = host.clock.now();
  const [refs, rows] = await Promise.all([
    host.agents.list(projectId),
    host.db
      .select()
      .from(agent)
      .where(and(eq(agent.projectId, projectId), eq(agent.workspaceId, workspaceId)))
      .orderBy(desc(agent.createdAt), desc(agent.id)),
  ]);
  const hosts = refs
    .map(hostAgent)
    .filter((ref) => ref.projectId === projectId && ref.workspaceId === workspaceId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const listed = new Set(hosts.map((ref) => ref.agentId));
  return {
    agents: [
      ...hosts.map((ref) => hostsAgent(ref, byId.get(ref.agentId), now)),
      ...rows
        .filter((row) => row.tokenHash !== null && !listed.has(row.id))
        .map((row) => ownAgent(row, now)),
    ],
  };
}

const forbidden = () => new DevSyncError("forbidden", REFUSAL.devSyncOff);

/**
 * The agent a bearer token belongs to, and its project as the host answers it now. The host's
 * `agents.verify` is asked first, on every request; then DevSync's own rows not yet moved to the
 * host; then the host once more, as the token's move may have committed in between. Refused alike
 * (`unauthenticated`) when none knows a live agent for the token (a host's agent revoked or expired
 * is refused, whatever DevSync's row of it holds), and `forbidden` when the token is live but its
 * project is gone or has DevSync off. Records when the agent was last seen.
 */
export async function authenticateAgent(host: DevSyncHost, token: string): Promise<AgentActor> {
  const refused = new DevSyncError("unauthenticated", REFUSAL.unauthenticated);
  if (typeof token !== "string" || token === "") throw refused;
  const ref = await host.agents.verify(token);
  if (ref) return hostsActor(host, hostAgent(ref));
  // Only DevSync's own tokens have this shape.
  if (!TOKEN_SHAPE.test(token)) throw refused;
  const own = await ownActor(host, token);
  if (own) return own;
  const moved = await host.agents.verify(token);
  if (moved) return hostsActor(host, hostAgent(moved));
  throw refused;
}

/**
 * A host's agent as the actor: DevSync's row of it is made the first time it is seen (with no
 * token, so the foreign keys hold), and takes the host's name and liveness each time after.
 */
async function hostsActor(host: DevSyncHost, ref: AgentRef): Promise<AgentActor> {
  const project = await host.project(ref.projectId);
  if (!project || project.projectId !== ref.projectId || project.workspaceId !== ref.workspaceId) {
    throw forbidden();
  }
  const now = host.clock.now();
  const [row] = await host.db
    .insert(agent)
    .values({
      id: ref.agentId,
      workspaceId: ref.workspaceId,
      projectId: ref.projectId,
      name: ref.name,
      kind: KIND_OF[ref.kind],
      lastSeenAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: agent.id,
      // The host verified it, so it is live: a revoke DevSync recorded before the move is undone.
      set: { name: ref.name, revokedAt: null, lastSeenAt: now },
      setWhere: and(eq(agent.projectId, ref.projectId), eq(agent.workspaceId, ref.workspaceId)),
    })
    .returning({ id: agent.id, name: agent.name });
  if (!row) throw new Error(`DevSync has the host's agent ${ref.agentId} in another project.`);
  return { kind: "agent", agentId: row.id, name: row.name, project };
}

/**
 * One of DevSync's own agents, not yet moved to the host, as the actor; null when DevSync has no
 * live row with the token (unknown, expired, revoked, or moved meanwhile).
 */
async function ownActor(host: DevSyncHost, token: string): Promise<AgentActor | null> {
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
  if (!found) return null;
  const project = await host.project(found.projectId);
  if (
    !project ||
    project.projectId !== found.projectId ||
    project.workspaceId !== found.workspaceId
  ) {
    throw forbidden();
  }
  const [seen] = await host.db
    .update(agent)
    .set({ lastSeenAt: now })
    .where(and(eq(agent.id, found.id), live))
    .returning({ id: agent.id, name: agent.name });
  return seen ? { kind: "agent", agentId: seen.id, name: seen.name, project } : null;
}

/**
 * `devsync.agents-move`, hourly: moves DevSync's own agents, every row that still has a token, to
 * the host with `host.agents.adopt`, keeping their ids and token hashes, so their tokens go on
 * working. One transaction per project adopts its rows and nulls their token columns. A project
 * the host doesn't answer (gone, or DevSync off) is skipped, and one whose move fails is logged;
 * both are tried again next hour. Answers how many agents moved.
 */
export async function moveAgents(host: DevSyncHost): Promise<number> {
  const projects = await host.db
    .selectDistinct({ projectId: agent.projectId })
    .from(agent)
    .where(isNotNull(agent.tokenHash))
    .orderBy(asc(agent.projectId));
  let moved = 0;
  for (const { projectId } of projects) {
    const project = await host.project(projectId);
    if (project?.projectId !== projectId) continue;
    try {
      moved += await host.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.projectId, projectId),
              eq(agent.workspaceId, project.workspaceId),
              isNotNull(agent.tokenHash),
              isNotNull(agent.expiresAt),
            ),
          )
          .orderBy(asc(agent.createdAt), asc(agent.id))
          .for("update");
        // The `where` holds both token columns: neither is null here.
        const adopted = rows.map(
          (row): AdoptedAgent => ({
            agentId: row.id,
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            name: row.name,
            kind: HOST_KIND[row.kind],
            tokenHash: row.tokenHash as string,
            expiresAt: row.expiresAt as Date,
            revokedAt: row.revokedAt,
            lastSeenAt: row.lastSeenAt,
            registeredBy: row.registeredByUserId,
            createdAt: row.createdAt,
          }),
        );
        if (adopted.length === 0) return 0;
        await host.agents.adopt(tx, adopted);
        await tx
          .update(agent)
          .set({ tokenHash: null, expiresAt: null })
          .where(
            inArray(
              agent.id,
              adopted.map((a) => a.agentId),
            ),
          );
        return adopted.length;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      host.log.error(
        `DevSync couldn't move project ${projectId}'s agents to the host (${reason}); it tries again next hour.`,
      );
    }
  }
  return moved;
}
