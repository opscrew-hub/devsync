/**
 * What the server's own tests share beyond `@devsync/server/testing`: the clock, refusals, a
 * security finding, and agents (the host's, and DevSync's own not yet moved).
 */
import type { AgentKind } from "@devsync/schemas";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { agent } from "../db";
import { authenticateAgent, HOST_KIND, hashToken } from "../domain/agents";
import {
  type AgentActor,
  DevSyncError,
  type ErrorCode,
  type Finding,
  type ProjectRef,
} from "../host";
import { type FakeHost, fakeToken } from "../testing";

/** How long a token lasts, the host's and DevSync's own. */
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** A test's agent: its id, its token, and the actor the MCP endpoint authenticates it as. */
export interface TestAgent {
  id: string;
  token: string;
  actor: AgentActor;
}

/**
 * Registers an agent for `project` on the fake host, as the host's Agents dialog does (its token
 * lasting 24 hours from now), and connects it to DevSync once, which makes DevSync's row of it.
 */
export async function hostAgent(
  host: FakeHost,
  project: ProjectRef,
  fields: { name: string; kind: AgentKind },
): Promise<TestAgent> {
  const token = fakeToken();
  const agentId = crypto.randomUUID();
  host.directory.agents.push({
    agentId,
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    name: fields.name,
    kind: HOST_KIND[fields.kind],
    modules: ["devsync"],
    tokenHash: hashToken(token),
    expiresAt: new Date(host.clock.now().getTime() + TOKEN_LIFETIME_MS),
    revokedAt: null,
  });
  return { id: agentId, token, actor: await authenticateAgent(host, token) };
}

function hostsAgent(host: FakeHost, agentId: string) {
  const found = host.directory.agents.find((a) => a.agentId === agentId);
  if (!found) throw new Error(`The fake host has no agent ${agentId}.`);
  return found;
}

/** A new token for the host's agent, as the host's rotate gives it: the old one stops working. */
export function rotateHostAgent(host: FakeHost, agentId: string): string {
  const token = fakeToken();
  const found = hostsAgent(host, agentId);
  found.tokenHash = hashToken(token);
  found.expiresAt = new Date(host.clock.now().getTime() + TOKEN_LIFETIME_MS);
  found.revokedAt = null;
  return token;
}

/**
 * Revokes the host's agent, and DevSync's row of it. That models only a revoke made before the
 * move (DevSync revoked its own agent, and the move kept the revoke on both sides): the one revoke
 * DevSync's own queries see. A revoke on the dashboard after the move leaves DevSync's row
 * unrevoked (docs/host.md, MCP for coding agents); to model one, set only the host's `revokedAt`.
 */
export async function revokeHostAgent(host: FakeHost, agentId: string): Promise<void> {
  const now = host.clock.now();
  hostsAgent(host, agentId).revokedAt = now;
  await host.db.update(agent).set({ revokedAt: now }).where(eq(agent.id, agentId));
}

/**
 * One of DevSync's own agents, registered before the host had agents and not yet moved: a row with
 * its token's hash, lasting 24 hours from now.
 */
export async function devsyncAgent(
  host: FakeHost,
  project: ProjectRef,
  fields: { name: string; kind: AgentKind; registeredByUserId?: string },
): Promise<{ id: string; token: string }> {
  const token = fakeToken();
  const now = host.clock.now();
  const [row] = await host.db
    .insert(agent)
    .values({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      name: fields.name,
      kind: fields.kind,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS),
      registeredByUserId: fields.registeredByUserId ?? null,
      createdAt: now,
    })
    .returning({ id: agent.id });
  if (!row) throw new Error("The agent wasn't saved.");
  return { id: row.id, token };
}

/** A security finding as the host gives it: a secret exposed at `src/app.ts:12`. */
export function sampleFinding(fields: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "config/client-exposed-secret:src/app.ts:12",
    ruleId: "config/client-exposed-secret",
    title: "A secret is exposed to the browser",
    severity: "high",
    file: "src/app.ts",
    line: 12,
    description: "The value is bundled into the client's code.",
    remediation: "Read it on the server only.",
    firstSeenAt: "2026-02-01T00:00:00.000Z",
    lastSeenAt: "2026-02-20T00:00:00.000Z",
    dismissal: null,
    ...fields,
  };
}

/** Moves the fake host's clock to `at`, in milliseconds since the epoch. */
export function setClock(host: FakeHost, at: number): void {
  host.clock = { now: () => new Date(at) };
}

/** The `DevSyncError` that `promise` is refused with, and with `code` when one is given. */
export async function refusal(promise: Promise<unknown>, code?: ErrorCode): Promise<DevSyncError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DevSyncError);
  if (code) expect((error as DevSyncError).code).toBe(code);
  return error as DevSyncError;
}
