/**
 * What the domain files share: parsing an input, the read-only check, the agent-row lock, and the
 * refusals more than one of them gives. Internal to the domain: the package's index doesn't export it.
 */
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { agent } from "../db";
import { type AgentActor, type DevSyncDb, DevSyncError, type ProjectRef } from "../host";

/** The refusals' texts, plain English, each saying what to do next. */
export const REFUSAL = {
  unauthenticated: "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.",
  devSyncOff: "DevSync is off for this project. Ask an Owner or Admin to switch it on.",
  readOnly:
    "This project is read-only because its workspace is past its plan. Ask an Owner to upgrade the plan.",
  claimNotActive:
    "This claim is no longer active: it expired, was released or ended with a report. Claim the task again if it is Ready.",
  /** A task not found, told to a member (and an agent editing one). */
  noSuchTask: "There's no such task in this project.",
  /** A task not found, told to an agent claiming it or reporting on it. */
  noSuchTaskForAgent: "There's no such task in this project. Check its id with get_project_state.",
  /** An agent not found, told to an Owner or Admin managing agents. */
  noSuchAgent: "There's no such agent in this project. Reload the agents list.",
  /** A message's recipient not found, told to a member. */
  noSuchRecipient:
    "There's no such agent in this project, or it was revoked. Reload the agents list.",
  /** A signal's recipient not found, told to an agent. */
  noSuchPeer:
    "There's no such agent in this project, or it was revoked. Check the agent's id with get_project_state.",
  noSuchSignal: "There's no such signal in your inbox. Check its id with get_pending_signals.",
} as const;

/** Parses `input` with `schema`, refusing it as `invalid` with the fields' names (never values). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "body"))];
  throw new DevSyncError(
    "invalid",
    `Check ${fields.length === 1 ? "this field" : "these fields"} and try again: ${fields.join(", ")}.`,
    fields,
  );
}

/** Refuses a write to a read-only project (past its workspace's plan), a member's or an agent's. */
export function requireWritable(project: ProjectRef): void {
  if (project.readOnly) throw new DevSyncError("forbidden", REFUSAL.readOnly);
}

/**
 * Locks the agent's row in `tx` (`FOR NO KEY UPDATE`), so one agent's idempotent writes and its
 * signal limits are checked one at a time.
 */
export async function lockAgentRow(tx: DevSyncDb, actor: AgentActor): Promise<void> {
  const [row] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, actor.agentId), eq(agent.projectId, actor.project.projectId)))
    .for("no key update");
  if (!row) throw new DevSyncError("unauthenticated", REFUSAL.unauthenticated);
}
