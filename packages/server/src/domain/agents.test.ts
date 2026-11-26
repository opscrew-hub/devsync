import { createHash } from "node:crypto";
import { AgentList } from "@devsync/schemas";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent } from "../db";
import type { AgentRef, ProjectContext, ProjectRef } from "../host";
import {
  devsyncAgent,
  hostAgent,
  refusal,
  revokeHostAgent,
  rotateHostAgent,
  setClock,
} from "../test/helpers";
import {
  createTestDb,
  FAKE_NOW,
  type FakeHost,
  type FakeHostAgent,
  fakeHost,
  fakeToken,
  type TestDb,
} from "../testing";
import { authenticateAgent, listAgents, moveAgents } from "./agents";

const HOUR = 60 * 60 * 1000;
const START = Date.parse(FAKE_NOW);
const REFUSED = "The token is invalid, expired or revoked. Ask an Owner or Admin for a new one.";
const DEVSYNC_OFF = "DevSync is off for this project. Ask an Owner or Admin to switch it on.";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** Two projects with DevSync on in one workspace, a member, and a host that knows them. */
function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/app",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const developer = { userId: crypto.randomUUID(), name: "Dev", role: "developer" as const };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [developer] },
    projects: [project, other],
  });
  const ctx = (on: ProjectRef = project): ProjectContext => ({ project: on, member: developer });
  return { host, project, other, developer, ctx };
}

/** An agent on the fake host with a fresh token, not yet seen by DevSync. */
function registerOnHost(
  host: FakeHost,
  on: ProjectRef,
  fields: Partial<FakeHostAgent> = {},
): { ref: FakeHostAgent; token: string } {
  const token = fakeToken();
  const ref: FakeHostAgent = {
    agentId: crypto.randomUUID(),
    projectId: on.projectId,
    workspaceId: on.workspaceId,
    name: "Helper",
    kind: "other",
    modules: ["devsync"],
    tokenHash: sha256(token),
    expiresAt: new Date(START + 24 * HOUR),
    revokedAt: null,
    ...fields,
  };
  host.directory.agents.push(ref);
  return { ref, token };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const rowOf = async (id: string) => {
  const [row] = await testDb.db.select().from(agent).where(eq(agent.id, id));
  return row;
};

describe("listAgents", () => {
  it("answers the host's agents with what DevSync saw of them, then its own not yet moved, newest first", async () => {
    const { host, project, other, ctx } = setup();
    const active = await hostAgent(host, project, { name: "Active", kind: "CLAUDE" });
    setClock(host, START + 1000);
    const idle = await hostAgent(host, project, { name: "Idle", kind: "CODEX" });
    const never = registerOnHost(host, project, { name: "Never", kind: "other" });
    // Revoked on the host: it isn't listed, and neither is DevSync's row of it.
    const gone = await hostAgent(host, project, { name: "Gone", kind: "CODEX" });
    host.directory.agents = host.directory.agents.filter((a) => a.agentId !== gone.id);
    registerOnHost(host, project, { name: "Not for DevSync", modules: [] });
    await hostAgent(host, other, { name: "Elsewhere", kind: "CODEX" });
    // Renamed on the host since it last connected.
    const renamed = host.directory.agents.find((a) => a.agentId === idle.id);
    if (renamed) renamed.name = "Idle reviewer";

    setClock(host, START + 2000);
    const revoked = await devsyncAgent(host, project, { name: "Revoked", kind: "CLAUDE" });
    await testDb.db
      .update(agent)
      .set({ revokedAt: new Date(START + 2000) })
      .where(eq(agent.id, revoked.id));
    setClock(host, START + 3000);
    const own = await devsyncAgent(host, project, { name: "Own", kind: "CODEX" });
    await devsyncAgent(host, other, { name: "Theirs", kind: "CODEX" });
    setClock(host, START + 3000 + 90 * 1000);
    await authenticateAgent(host, active.token);
    setClock(host, START + 3000 + 2 * 60 * 1000 + 1000);

    const answer = await listAgents(host, ctx());
    expect(AgentList.parse(answer)).toEqual(answer);
    expect(answer.agents.map((a) => [a.name, a.kind, a.status])).toEqual([
      ["Active", "CLAUDE", "Recently active"],
      ["Idle reviewer", "CODEX", "Offline"],
      ["Never", "OTHER", "Offline"],
      ["Own", "CODEX", "Offline"],
      ["Revoked", "CLAUDE", "Revoked"],
    ]);
    const byName = new Map(answer.agents.map((a) => [a.name, a]));
    expect(byName.get("Idle reviewer")).toEqual({
      id: idle.id,
      name: "Idle reviewer",
      kind: "CODEX",
      status: "Offline",
      expiresAt: null,
      lastSeenAt: new Date(START + 1000).toISOString(),
      createdAt: new Date(START + 1000).toISOString(),
    });
    expect(byName.get("Never")).toMatchObject({
      id: never.ref.agentId,
      expiresAt: null,
      lastSeenAt: null,
      createdAt: null,
    });
    expect(byName.get("Own")).toEqual({
      id: own.id,
      name: "Own",
      kind: "CODEX",
      status: "Offline",
      expiresAt: new Date(START + 3000 + 24 * HOUR).toISOString(),
      lastSeenAt: null,
      createdAt: new Date(START + 3000).toISOString(),
    });

    // Past its 24 hours, DevSync's own token is Expired.
    setClock(host, START + 3000 + 24 * HOUR);
    const later = await listAgents(host, ctx());
    expect(later.agents.find((a) => a.id === own.id)?.status).toBe("Expired");
    expect(JSON.stringify(later)).not.toContain(own.token);
  });

  it("fails as unexpected when the host's agent doesn't parse, naming its fields only", async () => {
    const { host, project, ctx } = setup();
    host.agents.list = async () => [
      {
        agentId: crypto.randomUUID(),
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        name: "Odd",
        kind: "robot",
        modules: ["devsync"],
      } as unknown as AgentRef,
    ];
    const error = await listAgents(host, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "The host's agent doesn't match DevSync's schema at kind.",
    );
    expect((error as Error).message).not.toContain("robot");
  });
});

describe("authenticateAgent", () => {
  it("asks the host first: its agent gets DevSync's row the first time, the host's name after", async () => {
    const { host, project } = setup();
    const { ref, token } = registerOnHost(host, project, { name: "Helper", kind: "other" });

    expect(await authenticateAgent(host, token)).toEqual({
      kind: "agent",
      agentId: ref.agentId,
      name: "Helper",
      project,
    });
    expect(await rowOf(ref.agentId)).toMatchObject({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      name: "Helper",
      kind: "OTHER",
      tokenHash: null,
      expiresAt: null,
      revokedAt: null,
      lastSeenAt: new Date(START),
      createdAt: new Date(START),
    });

    ref.name = "Reviewer";
    setClock(host, START + HOUR);
    expect((await authenticateAgent(host, token)).name).toBe("Reviewer");
    expect(await rowOf(ref.agentId)).toMatchObject({
      name: "Reviewer",
      lastSeenAt: new Date(START + HOUR),
      createdAt: new Date(START),
    });
    expect(
      await testDb.db.select({ id: agent.id }).from(agent).where(eq(agent.id, ref.agentId)),
    ).toHaveLength(1);
  });

  it("refuses the host's agent revoked, expired or kept from DevSync, whatever DevSync's row holds", async () => {
    const { host, project } = setup();
    const revoked = await hostAgent(host, project, { name: "Revoked", kind: "CODEX" });
    const expired = await hostAgent(host, project, { name: "Expired", kind: "CLAUDE" });
    const kept = await hostAgent(host, project, { name: "Kept", kind: "CLAUDE" });
    const entry = (id: string) => host.directory.agents.find((a) => a.agentId === id);
    // Revoked on the host only: DevSync's row of it is still unrevoked.
    const onHost = entry(revoked.id);
    if (onHost) onHost.revokedAt = new Date(START);
    const keptEntry = entry(kept.id);
    if (keptEntry) keptEntry.modules = [];
    setClock(host, START + HOUR);
    const expiredEntry = entry(expired.id);
    if (expiredEntry) expiredEntry.expiresAt = new Date(START + HOUR);

    for (const { id, token } of [revoked, expired, kept]) {
      const error = await refusal(authenticateAgent(host, token), "unauthenticated");
      expect(error.message).toBe(REFUSED);
      expect(error.message).not.toContain(token);
      expect((await rowOf(id))?.lastSeenAt).toEqual(new Date(START));
    }
    expect((await rowOf(revoked.id))?.revokedAt).toBeNull();
  });

  it("refuses the host's agent as forbidden when the host answers its project elsewhere or not at all", async () => {
    const { host, project } = setup();
    const helper = await hostAgent(host, project, { name: "Helper", kind: "CODEX" });
    // The host answers the project under another workspace.
    host.directory.projects = host.directory.projects.map((p) =>
      p.projectId === project.projectId ? { ...p, workspaceId: crypto.randomUUID() } : p,
    );
    const errors = [await refusal(authenticateAgent(host, helper.token), "forbidden")];
    // Verified, then DevSync switched off before the project is read.
    const [ref] = await host.agents.list(project.projectId);
    host.directory.projects = host.directory.projects.filter(
      (p) => p.projectId !== project.projectId,
    );
    host.agents.verify = async () => ref ?? null;
    errors.push(await refusal(authenticateAgent(host, helper.token), "forbidden"));
    for (const error of errors) expect(error.message).toBe(DEVSYNC_OFF);
  });

  it("fails as unexpected for the host's agent DevSync has in another project, or an answer that doesn't parse", async () => {
    const { host, project, other } = setup();
    const theirs = await hostAgent(host, other, { name: "Theirs", kind: "CODEX" });
    const { token } = registerOnHost(host, project, { agentId: theirs.id });
    await expect(authenticateAgent(host, token)).rejects.toThrow(
      `DevSync has the host's agent ${theirs.id} in another project.`,
    );
    expect((await rowOf(theirs.id))?.projectId).toBe(other.projectId);

    host.agents.verify = async () => ({ agentId: "not-an-id" }) as unknown as AgentRef;
    await expect(authenticateAgent(host, fakeToken())).rejects.toThrow(
      /^The host's agent doesn't match DevSync's schema at agentId, projectId, /,
    );
  });

  it("then checks DevSync's own agents not yet moved, recording when one was last seen", async () => {
    const { host, project } = setup();
    const own = await devsyncAgent(host, project, { name: "Own", kind: "CODEX" });
    setClock(host, START + HOUR);
    expect(await authenticateAgent(host, own.token)).toEqual({
      kind: "agent",
      agentId: own.id,
      name: "Own",
      project,
    });
    expect((await rowOf(own.id))?.lastSeenAt).toEqual(new Date(START + HOUR));
  });

  it("refuses a malformed, unknown, expired or revoked token alike, as unauthenticated", async () => {
    const { host, project } = setup();
    const one = await devsyncAgent(host, project, { name: "One", kind: "CODEX" });
    const two = await devsyncAgent(host, project, { name: "Two", kind: "CLAUDE" });
    await testDb.db
      .update(agent)
      .set({ revokedAt: new Date(START) })
      .where(eq(agent.id, two.id));

    const errors = [
      await refusal(authenticateAgent(host, ""), "unauthenticated"),
      await refusal(authenticateAgent(host, "not a token"), "unauthenticated"),
      await refusal(authenticateAgent(host, fakeToken()), "unauthenticated"),
      await refusal(authenticateAgent(host, two.token), "unauthenticated"),
    ];
    // Expired: 24 hours after registration.
    setClock(host, START + 24 * HOUR);
    errors.push(await refusal(authenticateAgent(host, one.token), "unauthenticated"));

    for (const error of errors) {
      expect(error.message).toBe(REFUSED);
      expect(error.message).not.toContain(one.token);
    }
    expect((await rowOf(two.id))?.lastSeenAt).toBeNull();
  });

  it("refuses DevSync's own live token whose project is gone, has DevSync off or moved workspace as forbidden", async () => {
    const { host, project } = setup();
    const one = await devsyncAgent(host, project, { name: "One", kind: "CODEX" });

    host.directory.projects = host.directory.projects.filter((p) => p !== project);
    const errors = [await refusal(authenticateAgent(host, one.token), "forbidden")];
    host.directory.projects.push({ ...project, workspaceId: crypto.randomUUID() });
    errors.push(await refusal(authenticateAgent(host, one.token), "forbidden"));
    for (const error of errors) {
      expect(error.message).toBe(DEVSYNC_OFF);
      expect(error.message).not.toContain(one.token);
    }
    expect((await rowOf(one.id))?.lastSeenAt).toBeNull();

    host.directory.projects.pop();
    host.directory.projects.push(project);
    await authenticateAgent(host, one.token);
  });
});

describe("moveAgents", () => {
  it("moves DevSync's own agents to the host by project, keeping their ids, and their tokens go on working", async () => {
    const { host, project, other, developer } = setup();
    const live = await devsyncAgent(host, project, {
      name: "Live",
      kind: "CODEX",
      registeredByUserId: developer.userId,
    });
    setClock(host, START + 1000);
    const revoked = await devsyncAgent(host, project, { name: "Revoked", kind: "CLAUDE" });
    await testDb.db
      .update(agent)
      .set({ revokedAt: new Date(START + 1000) })
      .where(eq(agent.id, revoked.id));
    await authenticateAgent(host, live.token);
    const theirs = await devsyncAgent(host, other, { name: "Theirs", kind: "CODEX" });
    // The host's agent has no token here: nothing to move.
    const hosts = await hostAgent(host, project, { name: "Host's", kind: "CLAUDE" });

    expect(await moveAgents(host)).toBe(3);
    const calls = host.agents.adopted.map((call) => call.agents.map((a) => a.name));
    expect(calls.sort()).toEqual([["Live", "Revoked"], ["Theirs"]]);
    for (const call of host.agents.adopted) expect(call.tx).not.toBe(host.db);
    const moved = host.agents.adopted.flatMap((call) => call.agents);
    expect(moved.find((a) => a.agentId === live.id)).toEqual({
      agentId: live.id,
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      name: "Live",
      kind: "codex",
      tokenHash: sha256(live.token),
      expiresAt: new Date(START + 24 * HOUR),
      revokedAt: null,
      lastSeenAt: new Date(START + 1000),
      registeredBy: developer.userId,
      createdAt: new Date(START),
    });
    expect(moved.find((a) => a.agentId === revoked.id)).toMatchObject({
      kind: "claude",
      revokedAt: new Date(START + 1000),
      registeredBy: null,
    });
    expect(host.audits).toEqual([]);

    const rows = await testDb.db
      .select()
      .from(agent)
      .where(inArray(agent.id, [live.id, revoked.id, theirs.id, hosts.id]));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect([row.tokenHash, row.expiresAt]).toEqual([null, null]);
    expect(rows.find((r) => r.id === revoked.id)?.revokedAt).toEqual(new Date(START + 1000));

    // The same token, now the host's: the same agent.
    expect((await authenticateAgent(host, live.token)).agentId).toBe(live.id);
    await refusal(authenticateAgent(host, revoked.token), "unauthenticated");
    // A second run finds nothing left to move.
    expect(await moveAgents(host)).toBe(0);
    expect(host.agents.adopted).toHaveLength(2);
  });

  it("skips a project with DevSync off and moves it next time", async () => {
    const { host, project, other } = setup();
    const mine = await devsyncAgent(host, project, { name: "Mine", kind: "CODEX" });
    const theirs = await devsyncAgent(host, other, { name: "Theirs", kind: "CODEX" });
    const off = host.directory.projects.filter((p) => p.projectId === other.projectId);
    host.directory.projects = host.directory.projects.filter((p) => p !== other);

    expect(await moveAgents(host)).toBe(1);
    expect((await rowOf(theirs.id))?.tokenHash).toBe(sha256(theirs.token));
    expect((await rowOf(mine.id))?.tokenHash).toBeNull();

    host.directory.projects.push(...off);
    expect(await moveAgents(host)).toBe(1);
    expect((await rowOf(theirs.id))?.tokenHash).toBeNull();
    expect((await authenticateAgent(host, theirs.token)).agentId).toBe(theirs.id);
  });

  it("keeps a project's tokens when the host refuses its move, logs it without them and goes on", async () => {
    const { host, project, other } = setup();
    const refused = await devsyncAgent(host, project, { name: "Refused", kind: "CODEX" });
    const theirs = await devsyncAgent(host, other, { name: "Theirs", kind: "CODEX" });
    const adopt = host.agents.adopt;
    host.agents.adopt = async (tx, rows) => {
      if (rows.some((row) => row.projectId === project.projectId)) {
        throw new TypeError(`Refused ${rows[0]?.tokenHash}`);
      }
      return adopt(tx, rows);
    };

    expect(await moveAgents(host)).toBe(1);
    expect((await rowOf(refused.id))?.tokenHash).toBe(sha256(refused.token));
    expect((await rowOf(theirs.id))?.tokenHash).toBeNull();
    expect(host.errors).toEqual([
      `DevSync couldn't move project ${project.projectId}'s agents to the host (TypeError); it tries again next hour.`,
    ]);
    // Still DevSync's own, its token works.
    expect((await authenticateAgent(host, refused.token)).agentId).toBe(refused.id);
  });

  it("leaves a row whose project the host answers in another workspace", async () => {
    const { host, project } = setup();
    const stray = await devsyncAgent(host, project, { name: "Stray", kind: "CODEX" });
    host.directory.projects = host.directory.projects.map((p) =>
      p.projectId === project.projectId ? { ...p, workspaceId: crypto.randomUUID() } : p,
    );
    expect(await moveAgents(host)).toBe(0);
    expect(host.agents.adopted).toEqual([]);
    expect((await rowOf(stray.id))?.tokenHash).toBe(sha256(stray.token));
  });

  it("gives the host back an agent DevSync revoked before the move, once the host revives it", async () => {
    const { host, project } = setup();
    const own = await devsyncAgent(host, project, { name: "Own", kind: "CODEX" });
    await testDb.db
      .update(agent)
      .set({ revokedAt: new Date(START) })
      .where(eq(agent.id, own.id));
    await moveAgents(host);
    await refusal(authenticateAgent(host, own.token), "unauthenticated");

    // Rotated on the host: a new token, and DevSync's row is live again.
    const token = rotateHostAgent(host, own.id);
    expect((await authenticateAgent(host, token)).agentId).toBe(own.id);
    expect((await rowOf(own.id))?.revokedAt).toBeNull();
    await revokeHostAgent(host, own.id);
    await refusal(authenticateAgent(host, token), "unauthenticated");
  });
});
