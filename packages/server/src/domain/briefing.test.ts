/**
 * `get_briefing` (docs/host.md, MCP for coding agents): the task, its questions, paths, what it
 * waits for and its overlaps, with the context the host gives for its title, within 8,000
 * characters of JSON.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContextEntry, Member, ProjectContext, ProjectRef } from "../host";
import { hostAgent, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, type TestDb } from "../testing";
import { BRIEFING_LIMIT, getBriefing } from "./briefing";
import { answerQuestion, askQuestion } from "./questions";
import { createTask, updateTask } from "./tasks";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/** A project with an owner and an agent, and a task waiting for another, sharing its paths. */
async function setup(fields: { description?: string; acceptanceCriteria?: string } = {}) {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/shop",
    readOnly: false,
  };
  const owner: Member = { userId: crypto.randomUUID(), name: "Ana", role: "owner" };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner] },
    projects: [project],
  });
  const ctx: ProjectContext = { project, member: owner };
  const codex = await hostAgent(host, project, { name: "Codex", kind: "CODEX" });
  const cart = await createTask(host, ctx, {
    title: "Add a cart",
    description: "",
    acceptanceCriteria: "",
    owns: ["src/checkout/cart.ts"],
  });
  const created = await createTask(host, ctx, {
    title: "Ship checkout",
    description: fields.description ?? "Card payments",
    acceptanceCriteria: fields.acceptanceCriteria ?? "Pays",
    owns: ["src/checkout/"],
    dependsOn: [cart.id],
  });
  const ready = await updateTask(host, ctx, created.id, {
    version: created.version,
    status: "READY",
  });
  let now = Date.parse(FAKE_NOW);
  /** Asks a question a second after the last, and answers it when given an answer. */
  const ask = async (text: string, answer?: string) => {
    now += 1000;
    setClock(host, now);
    const asked = await askQuestion(host, ctx, ready.id, { text });
    return answer ? answerQuestion(host, ctx, asked.id, { answer }) : asked;
  };
  return { host, project, owner, ctx, codex, cart, task: ready, ask };
}

const entry = (kind: ContextEntry["kind"], text: string, trust: ContextEntry["trust"]) => ({
  source: `note ${text.slice(0, 8)}`,
  kind,
  author: "Ana",
  trust,
  text,
});

describe("a task's briefing", () => {
  it("gives the task, its questions, paths, waits and overlaps, and the host's context for its title", async () => {
    const s = await setup();
    const open = await s.ask("Which card network first?");
    const answered = await s.ask("Which currency?", "Euros.");
    const instruction = entry("instruction", "Run the payments tests first.", "trusted");
    const fact = entry("fact", "Checkout uses the payments API v2.", "untrusted");
    s.host.contextBlock = { instructions: [instruction], facts: [fact] };

    const briefing = await getBriefing(s.host, s.codex.actor, s.task.id);
    expect(briefing).toEqual({
      task: {
        id: s.task.id,
        title: "Ship checkout",
        description: "Card payments",
        acceptanceCriteria: "Pays",
        status: "READY",
        revision: 1,
      },
      openQuestions: [open],
      answeredQuestions: [answered],
      owns: ["src/checkout/"],
      waitsFor: [{ id: s.cart.id, title: "Add a cart", status: "BACKLOG" }],
      overlaps: [
        {
          task: { id: s.cart.id, title: "Add a cart", status: "BACKLOG" },
          paths: ["src/checkout/cart.ts"],
        },
      ],
      context: { instructions: [instruction], facts: [fact] },
      omitted: { contextEntries: 0, answeredQuestions: 0, openQuestions: 0 },
    });
    expect(s.host.contextAsked).toEqual([
      {
        caller: { projectId: s.project.projectId, agentId: s.codex.id },
        subject: "Ship checkout",
      },
    ]);

    // A member's, as the member may see it.
    const asMember = await getBriefing(s.host, s.ctx, s.task.id);
    expect(asMember).toEqual(briefing);
    expect(s.host.contextAsked[1]?.caller).toEqual({
      projectId: s.project.projectId,
      userId: s.owner.userId,
    });
    // A managed run's: the host takes no run there, so none is asked for.
    const asRun = await getBriefing(s.host, { project: s.project }, s.task.id);
    expect(asRun).toEqual({ ...briefing, context: { instructions: [], facts: [] } });
    expect(s.host.contextAsked).toHaveLength(2);
  });

  it("cuts the context first, from its last fact, then the oldest answered questions", async () => {
    const s = await setup();
    const answered = [];
    // About 1,400 characters each, the task's about 700: some 4,900 with three.
    for (const n of [1, 2, 3]) answered.push(await s.ask(`Question ${n}?`, "a".repeat(1000)));
    // About 2,100 characters each: room for one.
    const instructions = [1, 2].map((n) => entry("instruction", `${n}`.repeat(2000), "trusted"));
    const facts = [3, 4].map((n) => entry("fact", `${n}`.repeat(2000), "untrusted"));
    s.host.contextBlock = { instructions, facts };

    const first = await getBriefing(s.host, s.ctx, s.task.id);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(BRIEFING_LIMIT);
    expect(first.context).toEqual({ instructions: [instructions[0]], facts: [] });
    expect(first.answeredQuestions).toEqual(answered);
    expect(first.omitted).toEqual({ contextEntries: 3, answeredQuestions: 0, openQuestions: 0 });

    // Four more answers: past 8,000 without any context, so the oldest answers go, as few as fit.
    for (const n of [4, 5, 6, 7]) answered.push(await s.ask(`Question ${n}?`, "b".repeat(1000)));
    const second = await getBriefing(s.host, s.ctx, s.task.id);
    const cut = second.omitted.answeredQuestions;
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(BRIEFING_LIMIT);
    expect(second.context).toEqual({ instructions: [], facts: [] });
    expect(cut).toBeGreaterThan(0);
    expect(second.answeredQuestions).toEqual(answered.slice(cut));
    expect(second.omitted).toMatchObject({ contextEntries: 4, openQuestions: 0 });
    const oneMore = { ...second, answeredQuestions: answered.slice(cut - 1) };
    expect(JSON.stringify(oneMore).length).toBeGreaterThan(BRIEFING_LIMIT);
  });

  it("cuts the newest open questions last, once nothing else is left to cut", async () => {
    const s = await setup();
    const open = [];
    for (const n of [1, 2, 3, 4, 5, 6]) open.push(await s.ask(`${n}`.repeat(1000)));
    await s.ask("Which currency?", "Euros.");
    s.host.contextBlock = {
      instructions: [entry("instruction", "Test it.", "trusted")],
      facts: [],
    };
    const briefing = await getBriefing(s.host, s.codex.actor, s.task.id);
    const cut = briefing.omitted.openQuestions;
    expect(JSON.stringify(briefing).length).toBeLessThanOrEqual(BRIEFING_LIMIT);
    expect(briefing.omitted).toMatchObject({ contextEntries: 1, answeredQuestions: 1 });
    expect(cut).toBeGreaterThan(0);
    expect(briefing.openQuestions).toEqual(open.slice(0, open.length - cut));
    const oneMore = { ...briefing, openQuestions: open.slice(0, open.length - cut + 1) };
    expect(JSON.stringify(oneMore).length).toBeGreaterThan(BRIEFING_LIMIT);
  });

  it("keeps only the task whole past 8,000 characters", async () => {
    const s = await setup({ description: "d".repeat(5000), acceptanceCriteria: "c".repeat(4000) });
    await s.ask("Which card network first?");
    await s.ask("Which currency?", "Euros.");
    s.host.contextBlock = {
      instructions: [entry("instruction", "Test it.", "trusted")],
      facts: [],
    };
    const briefing = await getBriefing(s.host, s.codex.actor, s.task.id);
    expect(briefing.task.description).toBe("d".repeat(5000));
    expect(briefing.task.acceptanceCriteria).toBe("c".repeat(4000));
    expect(briefing.openQuestions).toEqual([]);
    expect(briefing.answeredQuestions).toEqual([]);
    expect(briefing.context).toEqual({ instructions: [], facts: [] });
    expect(briefing.omitted).toEqual({ contextEntries: 1, answeredQuestions: 1, openQuestions: 1 });
  });

  it("gives no context the host's answer doesn't parse, and logs where without its text", async () => {
    const s = await setup();
    s.host.context = async () => ({ instructions: [{ text: "Run it." }], facts: [] }) as never;
    const briefing = await getBriefing(s.host, s.codex.actor, s.task.id);
    expect(briefing.context).toEqual({ instructions: [], facts: [] });
    expect(s.host.errors).toEqual([
      "The host's context doesn't match DevSync's schema at instructions.0.source, instructions.0.kind, instructions.0.author, instructions.0.trust; the briefing has none.",
    ]);
    expect(s.host.errors[0]).not.toContain("Run it.");
  });
});
