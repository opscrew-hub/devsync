import { z } from "zod";
import { Id, LIMITS, Timestamp } from "./common";

/** The coding agents DevSync knows: Claude Code, Codex, or another agent the host registered. */
export const AgentKind = z.enum(["CLAUDE", "CODEX", "OTHER"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** What a signal (or a member's message to an agent) is about. */
export const SignalKind = z.enum([
  "clarification.requested",
  "clarification.answered",
  "review.requested",
  "system.warning",
]);
export type SignalKind = z.infer<typeof SignalKind>;

/** A message's text, to an agent or from one. */
export const MessageText = z.string().trim().min(1).max(LIMITS.message);

/** `POST /agents/:agentId/messages`, idempotent by its key. */
export const AgentMessage = z.strictObject({
  kind: SignalKind,
  message: MessageText,
  idempotencyKey: Id,
});
export type AgentMessage = z.infer<typeof AgentMessage>;

/**
 * An agent that may reach DevSync: one the host registered, or one of DevSync's own not yet moved
 * to the host. Never its token.
 */
export const Agent = z.object({
  id: Id,
  name: z.string(),
  kind: AgentKind,
  status: z.enum(["Recently active", "Offline", "Expired", "Revoked"]),
  /** When DevSync's own token expires; null for the host's agents, whose tokens the host shows. */
  expiresAt: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
  /** When DevSync first had the agent; null for one of the host's that hasn't connected yet. */
  createdAt: Timestamp.nullable(),
});
export type Agent = z.infer<typeof Agent>;

/** `GET /agents`. */
export const AgentList = z.object({ agents: z.array(Agent) });
export type AgentList = z.infer<typeof AgentList>;

/** `POST /agents/:agentId/messages`' answer. */
export const AgentMessageReceipt = z.object({ id: Id, kind: SignalKind, createdAt: Timestamp });
export type AgentMessageReceipt = z.infer<typeof AgentMessageReceipt>;
