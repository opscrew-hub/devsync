import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agent, AgentKind, AgentList, AgentMessage, AgentMessageReceipt } from "./agents";
import { MemberList } from "./members";

const text = (length: number) => "a".repeat(length);
const now = new Date().toISOString();

const agent = {
  id: randomUUID(),
  name: "Builder",
  kind: "CLAUDE",
  status: "Recently active",
  expiresAt: now,
  lastSeenAt: null,
  createdAt: now,
};

describe("AgentKind", () => {
  it("is Claude Code, Codex, or another agent the host registered", () => {
    expect(AgentKind.options).toEqual(["CLAUDE", "CODEX", "OTHER"]);
  });
});

describe("AgentMessage", () => {
  const valid = {
    kind: "clarification.answered",
    message: "Use the staging bucket.",
    idempotencyKey: randomUUID(),
  };

  it("takes a known kind, a message of 1 to 4000 characters and a UUID key", () => {
    expect(AgentMessage.safeParse(valid).success).toBe(true);
    expect(AgentMessage.safeParse({ ...valid, message: text(4000) }).success).toBe(true);
    expect(AgentMessage.safeParse({ ...valid, message: text(4001) }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...valid, kind: "hello" }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...valid, idempotencyKey: "k1" }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe("the answers", () => {
  it("parse agents, DevSync's own and the host's, and a message's receipt", () => {
    expect(AgentList.safeParse({ agents: [agent] }).success).toBe(true);
    // The host's: its token is the host's, and DevSync has no row of it before it connects.
    const hosts = { ...agent, kind: "OTHER", expiresAt: null, createdAt: null };
    expect(AgentList.safeParse({ agents: [hosts] }).success).toBe(true);
    expect(Agent.safeParse({ ...agent, status: "Online" }).success).toBe(false);
    expect(Agent.safeParse({ ...agent, kind: "GEMINI" }).success).toBe(false);
    expect(
      AgentMessageReceipt.safeParse({ id: randomUUID(), kind: "system.warning", createdAt: now })
        .success,
    ).toBe(true);
  });

  it("parse members with the host's roles", () => {
    const member = { userId: randomUUID(), name: "Ana", role: "approver" };
    expect(MemberList.safeParse({ members: [member] }).success).toBe(true);
    expect(MemberList.safeParse({ members: [{ ...member, role: "viewer" }] }).success).toBe(false);
  });
});
