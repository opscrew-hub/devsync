import { z } from "zod";
import { Id, LIMITS, Timestamp } from "./common";

/** The coding agents DevSync registers. */
export const AgentKind = z.enum(["CLAUDE", "CODEX"]);
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

/** `POST /agents`. */
export const AgentInput = z.strictObject({
  name: z.string().trim().min(1).max(LIMITS.name),
  kind: AgentKind,
});
export type AgentInput = z.infer<typeof AgentInput>;

/** `POST /agents/:agentId/messages`, idempotent by its key. */
export const AgentMessage = z.strictObject({
  kind: SignalKind,
  message: MessageText,
  idempotencyKey: Id,
});
export type AgentMessage = z.infer<typeof AgentMessage>;

/** A registered agent; never its token. */
export const Agent = z.object({
  id: Id,
  name: z.string(),
  kind: AgentKind,
  status: z.enum(["Recently active", "Offline", "Expired", "Revoked"]),
  expiresAt: Timestamp,
  lastSeenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Agent = z.infer<typeof Agent>;

/** `GET /agents`. */
export const AgentList = z.object({ agents: z.array(Agent) });
export type AgentList = z.infer<typeof AgentList>;

/** `POST /agents` and `POST /agents/:agentId/rotate`: the token, shown once. */
export const AgentWithToken = z.object({ agent: Agent, token: z.string().min(1) });
export type AgentWithToken = z.infer<typeof AgentWithToken>;

/** `POST /agents/:agentId/messages`' answer. */
export const AgentMessageReceipt = z.object({ id: Id, kind: SignalKind, createdAt: Timestamp });
export type AgentMessageReceipt = z.infer<typeof AgentMessageReceipt>;
